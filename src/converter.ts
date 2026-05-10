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
import { existsSync } from 'fs';

/**
 * Extract text from Anthropic message content (handles both string and array formats).
 * Claude Code sends: [{type: 'text', text: '...'}, {type: 'tool_use', ...}]
 * Simple clients send: 'plain string'
 */
function extractText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text || '')
      .join('\n');
  }
  return String(content || '');
}

/**
 * Extract text from system prompt (string or Anthropic content block array).
 */
function extractSystemText(system: any): string | undefined {
  if (!system) return undefined;
  if (typeof system === 'string') return system || undefined;
  if (Array.isArray(system)) {
    const text = system
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text || '')
      .join('\n');
    return text || undefined;
  }
  return undefined;
}

function formatMessageForPrompt(message: { role: string; content: unknown }): string {
  const text = extractText(message.content).trim();
  if (!text) return '';

  const label = message.role === 'assistant'
    ? 'Assistant'
    : message.role === 'user'
      ? 'User'
      : message.role || 'Message';
  return `${label}: ${text}`;
}

function buildPromptText(req: CompletionRequest): string {
  const conversationMessages = req.messages.filter(m => m.role !== 'system');
  const lastUserIndex = conversationMessages.map(m => m.role).lastIndexOf('user');
  const lastUserMsg = lastUserIndex >= 0 ? conversationMessages[lastUserIndex] : undefined;
  if (!lastUserMsg) throw new Error('No user message found in messages array');

  // OpenAI/Anthropic HTTP APIs are stateless: normal chat clients send the full
  // transcript on every request and do not know about our private cascade ID.
  // If the caller does provide x-conversation-id, Antigravity already has the
  // prior turns, so only send the latest user message to avoid duplicating them.
  const currentUserText = extractText(lastUserMsg.content).trim();
  const promptParts: string[] = [];

  const sysText = extractSystemText(req.system);
  if (sysText) {
    promptParts.push(`<system_instructions>\n${sysText}\n</system_instructions>`);
  }

  if (!req.conversationId) {
    const historyText = conversationMessages
      .slice(0, lastUserIndex)
      .map(formatMessageForPrompt)
      .filter(Boolean)
      .join('\n\n');
    if (historyText) {
      promptParts.push(`<conversation_history>\n${historyText}\n</conversation_history>`);
    }
  }

  promptParts.push(`<current_user_message>\n${currentUserText}\n</current_user_message>`);
  return promptParts.join('\n\n');
}

/** Debug logging — set DEBUG=1 to enable. */
const DEBUG = !!process.env.DEBUG;
function dbg(...args: any[]) { if (DEBUG) console.log('[DBG]', ...args); }

/**
 * Convert a file:// URI to an OS-native path Antigravity will accept.
 * Windows: `file:///D:/foo` → `D:/foo` (strip leading slash before drive letter).
 * Unix:    `file:///home/x` → `/home/x`.
 */
function fileUriToPath(uri: string): string {
  let p = uri.replace(/^file:\/\//, '');
  if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(p)) {
    p = p.slice(1);
  }
  return p;
}

const RESPONSE_TEXT_KEYS = [
  'modifiedResponse',
  'response',
  'text',
  'content',
  'markdown',
  'message',
  'output',
  'answer',
  'finalResponse',
  'responseText',
  'displayText',
];

const RESPONSE_CONTAINER_KEYS = [
  'parts',
  'chunks',
  'segments',
  'blocks',
  'items',
  'responseParts',
  'contentParts',
];

function extractTextValue(value: any, depth = 0): string {
  if (value == null || depth > 6) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return '';

  if (Array.isArray(value)) {
    return value.map(item => extractTextValue(item, depth + 1)).filter(Boolean).join('');
  }

  for (const key of RESPONSE_TEXT_KEYS) {
    const text = extractTextValue(value[key], depth + 1);
    if (text) return text;
  }

  for (const key of RESPONSE_CONTAINER_KEYS) {
    const text = extractTextValue(value[key], depth + 1);
    if (text) return text;
  }

  return '';
}

function extractStepContent(step: any): string {
  if (!step) return '';
  if (step.plannerResponse) {
    const text = extractTextValue(step.plannerResponse);
    if (text) return text;
  }

  // Some agentic steps embed the user-visible response directly on the step.
  return extractTextValue({
    response: step.response,
    text: step.text,
    content: step.content,
    markdown: step.markdown,
  });
}

/**
 * Extract the latest AI response text from a step list.
 * Antigravity has moved planner text across nested fields over versions, so
 * this accepts both direct strings and nested text/content/parts containers.
 */
function extractContent(steps: any[]): string {
  for (let i = steps.length - 1; i >= 0; i--) {
    const text = extractStepContent(steps[i]);
    if (text) return text;
  }
  return '';
}

function getRequestedInteraction(step: any): any {
  return step?.requestedInteraction
    || step?.codeAction?.requestedInteraction
    || step?.filePermissionRequest
    || step?.codeAction?.filePermissionRequest
    || null;
}

function hasRequestedInteraction(steps: any[]): boolean {
  return steps.some(step => !!getRequestedInteraction(step));
}

function hasDonePlannerResponse(steps: any[]): boolean {
  return steps.some(step =>
    step?.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE'
    && step?.status === 'CORTEX_STEP_STATUS_DONE'
    && !!extractStepContent(step)
  );
}

function logStepShapeDiagnostics(steps: any[], prefix: string, seen: Set<string>) {
  for (const step of steps) {
    if (!step) continue;

    if (step.plannerResponse) {
      const keys = Object.keys(step.plannerResponse).join(',');
      const key = `planner:${keys}`;
      if (!seen.has(key)) {
        seen.add(key);
        const text = extractStepContent(step);
        console.log(`${prefix} plannerResponse status=${step.status || '-'} keys=${keys || '-'} textLen=${text.length} sample=${JSON.stringify(text.slice(0, 240))}`);
      }
    }

    const interaction = getRequestedInteraction(step);
    if (interaction) {
      const keys = Object.keys(interaction).join(',');
      const key = `interaction:${step.type || '?'}:${keys}`;
      if (!seen.has(key)) {
        seen.add(key);
        console.log(`${prefix} requestedInteraction stepType=${step.type || '-'} stepStatus=${step.status || '-'} keys=${keys || '-'} body=${JSON.stringify(interaction).slice(0, 1200)}`);
      }
    }
  }
}

export interface CompletionRequest {
  messages: Array<{ role: string; content: unknown }>;
  model?: string;
  system?: unknown;
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
 *
 * The cascade gRPC API is served by the global (no-workspace) language_server.
 * Workspace context is passed in `workspaceUris` on each call. We pick a real
 * workspace path either from the caller hint or by borrowing one from any
 * discovered per-workspace language_server. If that path is stale (folder no
 * longer exists), fall back to process.cwd().
 */
function getConnection(workspace?: string) {
  const t0 = Date.now();
  const srv = workspace ? getLanguageServer(workspace) : getLanguageServer();
  const tDisc = Date.now();
  const apiKey = getApiKey();
  const tKey = Date.now();
  console.log(`⏱ getConnection: discover=${tDisc - t0}ms getApiKey=${tKey - tDisc}ms (total ${tKey - t0}ms)`);
  if (!srv || !apiKey) return null;

  // Resolve workspace URI: explicit hint > server's own workspace > borrow from any per-workspace server.
  let workspaceUri: string | undefined = workspace || srv.workspace;
  if (!workspaceUri) {
    const all = discoverLanguageServers();
    workspaceUri = all.find(s => !!s.workspace)?.workspace;
  }

  // Validate the chosen workspace actually exists on disk; if not, fall back to cwd.
  // Antigravity rejects AddTrackedWorkspace with 500 if the path is missing,
  // and the executor will silently bail right after USER_INPUT.
  if (workspaceUri) {
    const path = fileUriToPath(workspaceUri);
    if (!existsSync(path)) {
      const fallback = process.cwd().replace(/\\/g, '/');
      const fallbackUri = process.platform === 'win32'
        ? `file:///${fallback}`
        : `file://${fallback}`;
      console.log(`⚠️  workspace "${path}" does not exist — falling back to cwd "${fallback}"`);
      workspaceUri = fallbackUri;
    }
  } else {
    const fallback = process.cwd().replace(/\\/g, '/');
    workspaceUri = process.platform === 'win32' ? `file:///${fallback}` : `file://${fallback}`;
    console.log(`ℹ️  no workspace from discovery — using cwd "${fallback}"`);
  }

  return { ...srv, apiKey, workspace: workspaceUri };
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
  console.log(`🧠 complete: model=${req.model} → ${internalModel} maxWait=${maxWait}ms`);

  const promptText = buildPromptText(req);

  // Create or reuse conversation
  let cascadeId = req.conversationId;
  const tCascadeStart = Date.now();
  if (!cascadeId) {
    const wsUri = conn.workspace || 'file:///tmp/antigravity-playground';
    const wsPath = fileUriToPath(wsUri);
    const tA = Date.now();
    await grpc.addTrackedWorkspace(conn.port, conn.csrf, wsPath);
    const tB = Date.now();
    const cascade = await grpc.startCascade(conn.port, conn.csrf, conn.apiKey, wsUri);
    const tC = Date.now();
    cascadeId = cascade.cascadeId;
    if (!cascadeId) throw new Error('Failed to create conversation');
    // Required between StartCascade and SendUserCascadeMessage so the executor actually runs.
    await grpc.updateConversationAnnotations(conn.port, conn.csrf, conn.apiKey, cascadeId);
    const tD = Date.now();
    console.log(`⏱ new cascade: addTrackedWorkspace=${tB - tA}ms startCascade=${tC - tB}ms updateAnnotations=${tD - tC}ms`);
  } else {
    console.log(`♻️  reusing cascade=${cascadeId.slice(0,8)}`);
  }

  // IMPORTANT: subscribe to state updates BEFORE sending the message.
  // The Antigravity language_server starts the executor only when there's an
  // active subscriber listening to the cascade. If we send first and subscribe
  // after, the executor stays in IDLE forever.
  const tWaitStart = Date.now();
  const responsePromise = waitForResponse(conn.port, conn.csrf, conn.apiKey, cascadeId, internalModel, maxWait);

  // Now send the message (the trigger).
  const tSendStart = Date.now();
  await grpc.sendMessage(conn.port, conn.csrf, conn.apiKey, cascadeId, promptText, internalModel);
  const tSendDone = Date.now();
  console.log(`⏱ sendMessage=${tSendDone - tSendStart}ms promptLen=${promptText.length}chars cascadePhase=${tSendDone - tCascadeStart}ms`);

  const content = await responsePromise;
  console.log(`⏱ waitForResponse total=${Date.now() - tWaitStart}ms contentLen=${content.length}`);

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

  let promptText = '';
  try {
    promptText = buildPromptText(req);
  } catch (err: any) {
    yield { type: 'error', error: 'No user message found' };
    return;
  }

  // Create or reuse conversation
  let cascadeId = req.conversationId;
  const tCascadeStart = Date.now();
  if (!cascadeId) {
    const wsUri = conn.workspace || 'file:///tmp/antigravity-playground';
    const wsPath = fileUriToPath(wsUri);
    const tA = Date.now();
    await grpc.addTrackedWorkspace(conn.port, conn.csrf, wsPath);
    const tB = Date.now();
    const cascade = await grpc.startCascade(conn.port, conn.csrf, conn.apiKey, wsUri);
    const tC = Date.now();
    cascadeId = cascade.cascadeId;
    if (!cascadeId) {
      yield { type: 'error', error: 'Failed to create conversation' };
      return;
    }
    await grpc.updateConversationAnnotations(conn.port, conn.csrf, conn.apiKey, cascadeId);
    const tD = Date.now();
    console.log(`⏱ [stream] new cascade: addTrackedWorkspace=${tB - tA}ms startCascade=${tC - tB}ms updateAnnotations=${tD - tC}ms`);
  } else {
    console.log(`♻️  [stream] reusing cascade=${cascadeId.slice(0,8)}`);
  }

  yield { type: 'content_delta', text: '', conversationId: cascadeId };

  // Stream the response. streamResponse subscribes first, THEN calls the
  // trigger to send the user message — this is required so the executor runs.
  const cId = cascadeId;
  const tCascadeStartCaptured = tCascadeStart;
  yield* streamResponse(conn.port, conn.csrf, conn.apiKey, cId, internalModel, maxWait, async () => {
    const tSendStart = Date.now();
    await grpc.sendMessage(conn.port, conn.csrf, conn.apiKey, cId, promptText, internalModel);
    const tSendDone = Date.now();
    console.log(`⏱ [stream] sendMessage=${tSendDone - tSendStart}ms promptLen=${promptText.length}chars cascadePhase=${tSendDone - tCascadeStartCaptured}ms`);
  });
}

/**
 * Wait for the AI response by subscribing to StreamAgentStateUpdates.
 * Auto-approves blocking NOTIFY_USER steps so the agent continues.
 * Returns the full response text when the agent goes idle.
 */
function waitForResponse(port: number, csrf: string, apiKey: string, cascadeId: string, model: string, maxWaitMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let lastContent = '';
    let updateCount = 0;
    let autoApproving = false;
    const approvedUris = new Set<string>();

    // Diagnostics
    const tStart = Date.now();
    let tFirstUpdate = 0;
    let tFirstContent = 0;
    const seenStepTypes: string[] = [];
    const stepTypeCount = new Map<string, number>();

    const timeout = setTimeout(() => {
      abort();
      console.log(`⏱ waitForResponse TIMEOUT after ${maxWaitMs}ms — updates=${updateCount} lastContent=${lastContent.length}chars`);
      console.log(`   stepTypes: ${[...stepTypeCount.entries()].map(([t,n]) => `${t}×${n}`).join(', ') || '(none)'}`);
      console.log(`   sequence: ${seenStepTypes.join(' → ')}`);
      resolve(lastContent || '[Timeout: AI did not respond in time]');
    }, maxWaitMs);

    let lastStatus = '';
    let firstUpdateDumped = false;
    const shapeDiagnosticsSeen = new Set<string>();
    const abort = grpc.streamAgentState(
      port, csrf, cascadeId,
      (update) => {
        updateCount++;
        const status = update?.status || '';
        const stepsUpdate = update?.mainTrajectoryUpdate?.stepsUpdate;
        const steps: any[] = stepsUpdate?.steps || [];

        if (updateCount === 1) {
          tFirstUpdate = Date.now();
          console.log(`⏱ first update arrived after ${tFirstUpdate - tStart}ms`);
        }
        if (!firstUpdateDumped) {
          firstUpdateDumped = true;
          console.log(`🔎 first update keys=${Object.keys(update || {}).join(',')} body=${JSON.stringify(update).slice(0, 1500)}`);
        }

        // Track step type sequence — log when a NEW type appears
        if (steps.length) {
          const last = steps[steps.length - 1];
          const t = last?.type || '?';
          const prevLast = seenStepTypes[seenStepTypes.length - 1];
          if (t !== prevLast) {
            seenStepTypes.push(t);
            console.log(`🔸 step #${steps.length} type=${t} (Δ${Date.now() - tStart}ms) hasPR=${!!last?.plannerResponse}`);
          }
          stepTypeCount.set(t, (stepTypeCount.get(t) || 0) + 1);
        }

        // Log EVERY status transition (not just IDLE/ERROR) so we can see if the agent ever runs.
        if (status !== lastStatus) {
          const last = steps[steps.length - 1];
          console.log(`📡 wait #${updateCount} status=${lastStatus || '∅'} → ${status} (Δ${Date.now() - tStart}ms) steps=${steps.length} lastStepType=${last?.type || '-'} hasPR=${!!last?.plannerResponse}`);
          lastStatus = status;
        }
        dbg(`update#${updateCount} status=${status} steps=${steps.length}`);
        if (DEBUG && steps.length) {
          const last = steps[steps.length - 1];
          dbg(`  last step type=${last?.type} hasPR=${!!last?.plannerResponse} keys=${Object.keys(last || {}).join(',')}`);
        }

        if (steps.length) {
          logStepShapeDiagnostics(steps, '🔬', shapeDiagnosticsSeen);

          const content = extractContent(steps);
          if (content) {
            if (!tFirstContent) {
              tFirstContent = Date.now();
              console.log(`⏱ first content arrived after ${tFirstContent - tStart}ms (${content.length}chars)`);
            }
            lastContent = content;
          }

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

        if (lastContent && !autoApproving && (status === 'CASCADE_RUN_STATUS_IDLE' || hasRequestedInteraction(steps))) {
          const stillBlocking = steps.length > 0 ? getBlockingNotifyUri(steps) : null;
          if (stillBlocking === null) {
            clearTimeout(timeout);
            abort();
            const tEnd = Date.now();
            console.log(`✅ wait DONE after ${tEnd - tStart}ms status=${status || '-'} donePlanner=${hasDonePlannerResponse(steps)} requestedInteraction=${hasRequestedInteraction(steps)} (firstUpdate=${tFirstUpdate - tStart}ms firstContent=${tFirstContent ? tFirstContent - tStart : -1}ms updates=${updateCount} steps=${steps.length})`);
            console.log(`   stepTypes: ${[...stepTypeCount.entries()].map(([t,n]) => `${t}×${n}`).join(', ')}`);
            console.log(`   sequence: ${seenStepTypes.join(' → ')}`);
            resolve(lastContent);
          } else {
            console.log(`⏸ status=IDLE but still blocked on uri="${stillBlocking}" (autoApproving=${autoApproving}) — keeping connection open`);
          }
        }
      },
      (err) => {
        clearTimeout(timeout);
        console.log(`❌ streamAgentState error after ${updateCount} updates (${Date.now() - tStart}ms): ${err.message}`);
        console.log(`   stepTypes: ${[...stepTypeCount.entries()].map(([t,n]) => `${t}×${n}`).join(', ') || '(none)'}`);
        if (lastContent) resolve(lastContent);
        else reject(new Error(`Stream error: ${err.message}`));
      }
    );
  });
}

/**
 * Stream the AI response as chunks.
 * Auto-approves blocking NOTIFY_USER steps.
 *
 * IMPORTANT: subscribes to state updates FIRST, then calls `trigger()` to send
 * the user message. The Antigravity executor only runs when an active subscriber
 * is listening — sending before subscribing leaves the cascade stuck in IDLE.
 */
async function* streamResponse(port: number, csrf: string, apiKey: string, cascadeId: string, model: string, maxWaitMs: number, trigger: () => Promise<void>): AsyncGenerator<StreamChunk> {
  type QueueItem = StreamChunk | null;
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
  let updateCount = 0;
  let autoApproving = false;
  const approvedUris = new Set<string>();

  // Diagnostics
  const tStart = Date.now();
  let tFirstUpdate = 0;
  let tFirstContent = 0;
  let tFirstDelta = 0;
  let deltaCount = 0;
  const seenStepTypes: string[] = [];
  const stepTypeCount = new Map<string, number>();

  const timeout = setTimeout(() => {
    abort();
    console.log(`⏱ streamResponse TIMEOUT after ${maxWaitMs}ms — updates=${updateCount} lastContent=${lastContent.length}chars deltas=${deltaCount}`);
    console.log(`   stepTypes: ${[...stepTypeCount.entries()].map(([t,n]) => `${t}×${n}`).join(', ') || '(none)'}`);
    console.log(`   sequence: ${seenStepTypes.join(' → ')}`);
    console.log(`   --- last ${recentUpdates.length} update bodies ---`);
    for (const u of recentUpdates) console.log(`   ${u}`);
    push({ type: 'done', conversationId: cascadeId });
    push(null);
  }, maxWaitMs);

  let lastStatus = '';
  let firstUpdateDumped = false;
  const shapeDiagnosticsSeen = new Set<string>();
  // Keep ring buffer of last N raw update bodies for post-mortem on timeout/error.
  const RECENT_BUF_SIZE = 6;
  const recentUpdates: string[] = [];
  const abort = grpc.streamAgentState(
    port, csrf, cascadeId,
    (update) => {
      updateCount++;
      const status = update?.status || '';
      const stepsUpdate = update?.mainTrajectoryUpdate?.stepsUpdate;
      const steps: any[] = stepsUpdate?.steps || [];

      // Always keep recent updates for timeout post-mortem
      const updateStr = JSON.stringify(update);
      recentUpdates.push(`#${updateCount} status=${status} ${updateStr.slice(0, 800)}`);
      if (recentUpdates.length > RECENT_BUF_SIZE) recentUpdates.shift();

      if (updateCount === 1) {
        tFirstUpdate = Date.now();
        console.log(`⏱ [stream] first update arrived after ${tFirstUpdate - tStart}ms`);
      }
      if (!firstUpdateDumped) {
        firstUpdateDumped = true;
        console.log(`🔎 [stream] first update keys=${Object.keys(update || {}).join(',')} body=${updateStr.slice(0, 1500)}`);
      }

      // Track step type sequence — log every NEW type
      if (steps.length) {
        const last = steps[steps.length - 1];
        const t = last?.type || '?';
        const prevLast = seenStepTypes[seenStepTypes.length - 1];
        if (t !== prevLast) {
          seenStepTypes.push(t);
          console.log(`🔸 [stream] step #${steps.length} type=${t} (Δ${Date.now() - tStart}ms) hasPR=${!!last?.plannerResponse} keys=${Object.keys(last || {}).join(',')}`);
        }
        stepTypeCount.set(t, (stepTypeCount.get(t) || 0) + 1);
      }

      // Log EVERY status transition AND dump the full update body (so we can see error fields).
      if (status !== lastStatus) {
        const last = steps[steps.length - 1];
        console.log(`📡 stream #${updateCount} status=${lastStatus || '∅'} → ${status} (Δ${Date.now() - tStart}ms) steps=${steps.length} lastStepType=${last?.type || '-'} hasPR=${!!last?.plannerResponse}`);
        console.log(`   body=${updateStr.slice(0, 1500)}`);
        lastStatus = status;
      }
      dbg(`stream update#${updateCount} status=${status} steps=${steps.length}`);
      if (DEBUG && steps.length) {
        const last = steps[steps.length - 1];
        dbg(`  last step type=${last?.type} hasPR=${!!last?.plannerResponse} keys=${Object.keys(last || {}).join(',')}`);
      }

      if (steps.length) {
        logStepShapeDiagnostics(steps, '🔬 [stream]', shapeDiagnosticsSeen);

        const newContent = extractContent(steps);
        if (newContent && !tFirstContent) {
          tFirstContent = Date.now();
          console.log(`⏱ [stream] first content present after ${tFirstContent - tStart}ms (${newContent.length}chars)`);
        }
        if (newContent.length > lastContent.length) {
          const delta = newContent.slice(lastContent.length);
          lastContent = newContent;
          deltaCount++;
          if (!tFirstDelta) {
            tFirstDelta = Date.now();
            console.log(`⏱ [stream] first delta emitted after ${tFirstDelta - tStart}ms (${delta.length}chars)`);
          }
          push({ type: 'content_delta', text: delta, conversationId: cascadeId });
        }

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

      if (lastContent && !autoApproving && (status === 'CASCADE_RUN_STATUS_IDLE' || hasRequestedInteraction(steps))) {
        const stillBlocking = steps.length > 0 ? getBlockingNotifyUri(steps) : null;
        if (stillBlocking === null) {
          clearTimeout(timeout);
          abort();
          const tEnd = Date.now();
          console.log(`✅ [stream] DONE after ${tEnd - tStart}ms status=${status || '-'} donePlanner=${hasDonePlannerResponse(steps)} requestedInteraction=${hasRequestedInteraction(steps)} (firstUpdate=${tFirstUpdate - tStart}ms firstContent=${tFirstContent ? tFirstContent - tStart : -1}ms firstDelta=${tFirstDelta ? tFirstDelta - tStart : -1}ms updates=${updateCount} deltas=${deltaCount} steps=${steps.length})`);
          console.log(`   stepTypes: ${[...stepTypeCount.entries()].map(([t,n]) => `${t}×${n}`).join(', ')}`);
          console.log(`   sequence: ${seenStepTypes.join(' → ')}`);
          push({ type: 'done', conversationId: cascadeId });
          push(null);
        } else {
          console.log(`⏸ [stream] status=IDLE but blocked uri="${stillBlocking}" (autoApproving=${autoApproving})`);
        }
      }
    },
    (err) => {
      clearTimeout(timeout);
      console.log(`❌ [stream] streamAgentState error after ${updateCount} updates (${Date.now() - tStart}ms): ${err.message}`);
      console.log(`   stepTypes: ${[...stepTypeCount.entries()].map(([t,n]) => `${t}×${n}`).join(', ') || '(none)'}`);
      push({ type: 'error', error: err.message });
      push(null);
    }
  );

  // Subscription is now set up. Send the user message — this triggers the executor.
  try {
    await trigger();
  } catch (err: any) {
    clearTimeout(timeout);
    abort();
    console.log(`❌ [stream] trigger (sendMessage) failed: ${err.message}`);
    yield { type: 'error', error: err.message };
    return;
  }

  while (true) {
    await waitForItem();
    const item = queue.shift();
    if (item === null || item === undefined) break;
    yield item;
    if (item.type === 'done' || item.type === 'error') break;
  }
}
