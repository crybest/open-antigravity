/**
 * Core converter: sends a message to Antigravity and waits for the AI response
 * by subscribing to the streaming state updates.
 *
 * This is the heart of the project — it bridges the gap between
 * Antigravity's async conversation model and the synchronous request-response
 * model of OpenAI/Anthropic APIs.
 *
 * Key feature: auto-approval of blocking NOTIFY_USER steps.
 * When Antigravity creates/modifies files, it may emit a blocking NOTIFY_USER
 * step that pauses the agent waiting for user approval. This converter
 * automatically detects and approves these steps so the agent continues.
 */

import { discoverLanguageServers, getLanguageServer } from './bridge/discovery.js';
import { getApiKey } from './bridge/statedb.js';
import * as grpc from './bridge/grpc.js';
import { resolveModelId } from './models.js';

export interface CompletionRequest {
  messages: Array<{ role: string; content: string }>;
  model?: string;
  system?: string;
  workspace?: string;       // file:///path or auto-detect
  conversationId?: string;  // reuse existing conversation
  maxWaitMs?: number;        // timeout (default 120s)
}

export interface CompletionResult {
  conversationId: string;
  content: string;
  model: string;
  stopReason: 'end_turn' | 'timeout' | 'error';
}

export interface StreamChunk {
  type: 'content_delta' | 'done' | 'error';
  text?: string;
  conversationId?: string;
  error?: string;
}

/**
 * Get a server connection for the given workspace.
 */
function getConnection(workspace?: string) {
  const srv = workspace ? getLanguageServer(workspace) : getLanguageServer();
  const apiKey = getApiKey();
  if (!srv || !apiKey) return null;
  return { ...srv, apiKey };
}

/**
 * Check if a NOTIFY_USER step is blocking and needs auto-approval.
 * Returns the artifact URI to approve, or null if not blocking.
 */
function getBlockingNotifyUri(steps: any[]): string | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (!step) continue;
    const type = step.type || '';

    // If we hit a USER_INPUT after the last NOTIFY_USER, it means
    // the user already responded — no approval needed
    if (type === 'CORTEX_STEP_TYPE_USER_INPUT') return null;

    if (type === 'CORTEX_STEP_TYPE_NOTIFY_USER') {
      const nu = step.notifyUser || {};
      const blocked = nu.blockedOnUser ?? nu.isBlocking ?? false;
      if (!blocked) return null;

      // Get the first review path as the artifact URI
      const paths = nu.pathsToReview || nu.reviewAbsoluteUris || [];
      if (paths.length > 0) {
        // paths can be strings or objects with .uri
        const first = paths[0];
        return typeof first === 'string' ? first : (first?.uri || first?.absoluteUri || '');
      }
      // Blocking but no specific artifact — approve with empty URI
      return '';
    }
  }
  return null;
}

/**
 * Send a completion request and wait for the full response (non-streaming).
 */
export async function complete(req: CompletionRequest): Promise<CompletionResult> {
  const conn = getConnection(req.workspace);
  if (!conn) throw new Error('No Antigravity language_server found. Is Antigravity running?');

  const internalModel = resolveModelId(req.model);
  const maxWait = req.maxWaitMs || 120_000;

  // Build the message text (prepend system prompt if present)
  const userMessages = req.messages.filter(m => m.role === 'user' || m.role === 'assistant');
  const lastUserMsg = userMessages.filter(m => m.role === 'user').pop();
  if (!lastUserMsg) throw new Error('No user message found in messages array');

  let promptText = lastUserMsg.content;
  if (req.system) {
    promptText = `[System: ${req.system}]\n\n${promptText}`;
  }

  // Create or reuse conversation
  let cascadeId = req.conversationId;
  if (!cascadeId) {
    const wsUri = conn.workspace || 'file:///tmp/antigravity-playground';
    const wsPath = wsUri.replace(/^file:\/\//, '');
    await grpc.addTrackedWorkspace(conn.port, conn.csrf, wsPath);
    const cascade = await grpc.startCascade(conn.port, conn.csrf, conn.apiKey, wsUri);
    cascadeId = cascade.cascadeId;
    if (!cascadeId) throw new Error('Failed to create conversation');
  }

  // Send the message
  await grpc.sendMessage(conn.port, conn.csrf, conn.apiKey, cascadeId, promptText, internalModel);

  // Wait for AI response via streaming (with auto-approval)
  const content = await waitForResponse(conn.port, conn.csrf, conn.apiKey, cascadeId, internalModel, maxWait);

  return {
    conversationId: cascadeId,
    content,
    model: req.model || 'claude-sonnet-4-20250514',
    stopReason: 'end_turn',
  };
}

/**
 * Send a completion request and stream the response.
 * Yields chunks as they arrive.
 */
export async function* completeStream(req: CompletionRequest): AsyncGenerator<StreamChunk> {
  const conn = getConnection(req.workspace);
  if (!conn) {
    yield { type: 'error', error: 'No Antigravity language_server found. Is Antigravity running?' };
    return;
  }

  const internalModel = resolveModelId(req.model);
  const maxWait = req.maxWaitMs || 120_000;

  const userMessages = req.messages.filter(m => m.role === 'user');
  const lastUserMsg = userMessages.pop();
  if (!lastUserMsg) {
    yield { type: 'error', error: 'No user message found' };
    return;
  }

  let promptText = lastUserMsg.content;
  if (req.system) {
    promptText = `[System: ${req.system}]\n\n${promptText}`;
  }

  // Create or reuse conversation
  let cascadeId = req.conversationId;
  if (!cascadeId) {
    const wsUri = conn.workspace || 'file:///tmp/antigravity-playground';
    const wsPath = wsUri.replace(/^file:\/\//, '');
    await grpc.addTrackedWorkspace(conn.port, conn.csrf, wsPath);
    const cascade = await grpc.startCascade(conn.port, conn.csrf, conn.apiKey, wsUri);
    cascadeId = cascade.cascadeId;
    if (!cascadeId) {
      yield { type: 'error', error: 'Failed to create conversation' };
      return;
    }
  }

  yield { type: 'content_delta', text: '', conversationId: cascadeId };

  // Send the message
  await grpc.sendMessage(conn.port, conn.csrf, conn.apiKey, cascadeId, promptText, internalModel);

  // Stream the response (with auto-approval)
  yield* streamResponse(conn.port, conn.csrf, conn.apiKey, cascadeId, internalModel, maxWait);
}

/**
 * Wait for the AI response by subscribing to StreamAgentStateUpdates.
 * Auto-approves blocking NOTIFY_USER steps so the agent continues.
 * Returns the full response text when the agent goes idle.
 */
function waitForResponse(port: number, csrf: string, apiKey: string, cascadeId: string, model: string, maxWaitMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let lastContent = '';
    let autoApproving = false;  // prevent duplicate approvals
    const approvedUris = new Set<string>();  // track already approved URIs

    const timeout = setTimeout(() => {
      abort();
      resolve(lastContent || '[Timeout: AI did not respond in time]');
    }, maxWaitMs);

    const abort = grpc.streamAgentState(
      port, csrf, cascadeId,
      (update) => {
        const status = update?.status || '';
        const stepsUpdate = update?.mainTrajectoryUpdate?.stepsUpdate;

        if (stepsUpdate?.steps?.length) {
          const steps = stepsUpdate.steps;

          // Collect latest PLANNER_RESPONSE content
          for (let i = steps.length - 1; i >= 0; i--) {
            const step = steps[i];
            if (step?.plannerResponse) {
              lastContent = step.plannerResponse.modifiedResponse || step.plannerResponse.response || '';
              break;
            }
          }

          // Check for blocking NOTIFY_USER → auto-approve
          if (!autoApproving) {
            const blockingUri = getBlockingNotifyUri(steps);
            if (blockingUri !== null) {
              const approvalKey = `${steps.length}:${blockingUri}`;
              if (!approvedUris.has(approvalKey)) {
                autoApproving = true;
                approvedUris.add(approvalKey);
                console.log(`🤖 Auto-approving NOTIFY_USER (uri="${blockingUri || 'none'}")`);
                grpc.proceedArtifact(port, csrf, apiKey, cascadeId, blockingUri, model)
                  .then(() => { autoApproving = false; })
                  .catch(() => { autoApproving = false; });
              }
            }
          }
        }

        // If agent is idle and we have content, and NOT waiting for approval, we're done
        if (status === 'CASCADE_RUN_STATUS_IDLE' && lastContent && !autoApproving) {
          // Double-check: make sure there's no pending blocking notify
          const steps = stepsUpdate?.steps || [];
          const stillBlocking = steps.length > 0 ? getBlockingNotifyUri(steps) : null;
          if (stillBlocking === null) {
            clearTimeout(timeout);
            abort();
            resolve(lastContent);
          }
        }
      },
      (err) => {
        clearTimeout(timeout);
        if (lastContent) resolve(lastContent);
        else reject(new Error(`Stream error: ${err.message}`));
      }
    );
  });
}

/**
 * Stream the AI response as chunks.
 * Auto-approves blocking NOTIFY_USER steps.
 */
async function* streamResponse(port: number, csrf: string, apiKey: string, cascadeId: string, model: string, maxWaitMs: number): AsyncGenerator<StreamChunk> {
  // Use a queue-based approach for async generator + callback bridge
  type QueueItem = StreamChunk | null; // null = done
  const queue: QueueItem[] = [];
  let resolve: (() => void) | null = null;

  function push(item: QueueItem) {
    queue.push(item);
    if (resolve) { resolve(); resolve = null; }
  }

  function waitForItem(): Promise<void> {
    if (queue.length > 0) return Promise.resolve();
    return new Promise(r => { resolve = r; });
  }

  let lastContent = '';
  let autoApproving = false;
  const approvedUris = new Set<string>();

  const timeout = setTimeout(() => {
    abort();
    push({ type: 'done', conversationId: cascadeId });
    push(null);
  }, maxWaitMs);

  const abort = grpc.streamAgentState(
    port, csrf, cascadeId,
    (update) => {
      const status = update?.status || '';
      const stepsUpdate = update?.mainTrajectoryUpdate?.stepsUpdate;

      if (stepsUpdate?.steps?.length) {
        const steps = stepsUpdate.steps;

        // Emit content deltas
        for (let i = steps.length - 1; i >= 0; i--) {
          const step = steps[i];
          if (step?.plannerResponse) {
            const newContent = step.plannerResponse.modifiedResponse || step.plannerResponse.response || '';
            if (newContent.length > lastContent.length) {
              const delta = newContent.slice(lastContent.length);
              lastContent = newContent;
              push({ type: 'content_delta', text: delta, conversationId: cascadeId });
            }
            break;
          }
        }

        // Auto-approve blocking NOTIFY_USER
        if (!autoApproving) {
          const blockingUri = getBlockingNotifyUri(steps);
          if (blockingUri !== null) {
            const approvalKey = `${steps.length}:${blockingUri}`;
            if (!approvedUris.has(approvalKey)) {
              autoApproving = true;
              approvedUris.add(approvalKey);
              console.log(`🤖 Auto-approving NOTIFY_USER (uri="${blockingUri || 'none'}")`);
              grpc.proceedArtifact(port, csrf, apiKey, cascadeId, blockingUri, model)
                .then(() => { autoApproving = false; })
                .catch(() => { autoApproving = false; });
            }
          }
        }
      }

      // Done: idle + content + not approving + no pending blocks
      if (status === 'CASCADE_RUN_STATUS_IDLE' && lastContent && !autoApproving) {
        const steps = stepsUpdate?.steps || [];
        const stillBlocking = steps.length > 0 ? getBlockingNotifyUri(steps) : null;
        if (stillBlocking === null) {
          clearTimeout(timeout);
          abort();
          push({ type: 'done', conversationId: cascadeId });
          push(null);
        }
      }
    },
    (err) => {
      clearTimeout(timeout);
      push({ type: 'error', error: err.message });
      push(null);
    }
  );

  // Yield from queue
  while (true) {
    await waitForItem();
    const item = queue.shift();
    if (item === null || item === undefined) break;
    yield item;
    if (item.type === 'done' || item.type === 'error') break;
  }
}
