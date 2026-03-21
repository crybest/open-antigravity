/**
 * Core converter: sends a message to Antigravity and waits for the AI response
 * by subscribing to the streaming state updates.
 *
 * This is the heart of the project — it bridges the gap between
 * Antigravity's async conversation model and the synchronous request-response
 * model of OpenAI/Anthropic APIs.
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

  // Wait for AI response via streaming
  const content = await waitForResponse(conn.port, conn.csrf, cascadeId, maxWait);

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

  // Stream the response
  yield* streamResponse(conn.port, conn.csrf, cascadeId, maxWait);
}

/**
 * Wait for the AI response by subscribing to StreamAgentStateUpdates.
 * Returns the full response text when the agent goes idle.
 */
function waitForResponse(port: number, csrf: string, cascadeId: string, maxWaitMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let lastContent = '';
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
          // Find the last PLANNER_RESPONSE step
          for (let i = steps.length - 1; i >= 0; i--) {
            const step = steps[i];
            if (step?.plannerResponse) {
              lastContent = step.plannerResponse.modifiedResponse || step.plannerResponse.response || '';
              break;
            }
          }
        }

        // If agent is idle and we have content, we're done
        if (status === 'CASCADE_RUN_STATUS_IDLE' && lastContent) {
          clearTimeout(timeout);
          abort();
          resolve(lastContent);
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
 */
async function* streamResponse(port: number, csrf: string, cascadeId: string, maxWaitMs: number): AsyncGenerator<StreamChunk> {
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
      }

      if (status === 'CASCADE_RUN_STATUS_IDLE' && lastContent) {
        clearTimeout(timeout);
        abort();
        push({ type: 'done', conversationId: cascadeId });
        push(null);
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
