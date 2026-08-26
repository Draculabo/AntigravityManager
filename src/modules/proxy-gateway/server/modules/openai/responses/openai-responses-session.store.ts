import { DurableRecordStore } from '@/shared/persistence/durable-record-store';
import type { OpenAIChatRequest } from '../../../common/interfaces/request-interfaces';

export interface OpenAIResponsesSession {
  inputItems: unknown[];
  instructions?: string;
  model: string;
  /** The completed Responses payload, so `GET /v1/responses/{id}` can replay it. */
  response?: Record<string, unknown>;
  /** What the request asked for. `false` means the payload is never retained. */
  store?: boolean;
  tools?: OpenAIChatRequest['tools'];
  toolCallItems?: unknown[];
}

/** What the Responses surface needs from the store, so a caller can be handed either. */
export interface OpenAIResponsesSessionStoreLike {
  clear(): void;
  delete(responseId: string): boolean;
  get(responseId: string): OpenAIResponsesSession | null;
  save(responseId: string, session: OpenAIResponsesSession): void;
}

export interface OpenAIResponsesSessionStoreOptions {
  /** Absolute path of the backing file. Omit to keep the store in memory only. */
  filePath?: string;
  maxSessions?: number;
  ttlMs?: number;
}

export const DEFAULT_OPENAI_RESPONSES_MAX_SESSIONS = 500;
export const DEFAULT_OPENAI_RESPONSES_SESSION_TTL_MS = 60 * 60 * 1000;

/**
 * Holds the state needed to support Responses API continuation.
 *
 * Gemini requires complete tool and assistant history, while Responses clients may
 * only send the next input with previous_response_id. Entries stay bounded by age
 * and by count because this is user content; given a `filePath` they also outlive
 * the process, so an id handed to a client before a restart still resolves after
 * one.
 */
export class OpenAIResponsesSessionStoreImpl implements OpenAIResponsesSessionStoreLike {
  private readonly sessions: DurableRecordStore<OpenAIResponsesSession>;

  public constructor(options: OpenAIResponsesSessionStoreOptions = {}) {
    this.sessions = new DurableRecordStore<OpenAIResponsesSession>({
      filePath: options.filePath,
      maxEntries: options.maxSessions ?? DEFAULT_OPENAI_RESPONSES_MAX_SESSIONS,
      ttlMs: options.ttlMs ?? DEFAULT_OPENAI_RESPONSES_SESSION_TTL_MS,
      revive: reviveOpenAIResponsesSession,
    });
  }

  public get(responseId: string): OpenAIResponsesSession | null {
    const session = this.sessions.get(responseId);
    return session ? cloneOpenAIResponsesSession(session) : null;
  }

  public save(responseId: string, session: OpenAIResponsesSession): void {
    this.sessions.set(responseId, {
      ...cloneOpenAIResponsesSession(session),
      toolCallItems: collectResponsesToolCallItems([
        ...(session.toolCallItems ?? []),
        ...session.inputItems,
      ]),
    });
  }

  public delete(responseId: string): boolean {
    return this.sessions.delete(responseId);
  }

  public clear(): void {
    this.sessions.clear();
  }

  /** Resolves once every pending write has reached the disk. */
  public flush(): Promise<void> {
    return this.sessions.flush();
  }
}

/**
 * The process-wide in-memory store.
 *
 * It is the fallback for callers assembled outside Nest; the injectable
 * `OpenAIResponsesSessionService` is the one that owns a file.
 */
export const OpenAIResponsesSessionStore = new OpenAIResponsesSessionStoreImpl();

function cloneOpenAIResponsesSession(session: OpenAIResponsesSession): OpenAIResponsesSession {
  return {
    inputItems: [...session.inputItems],
    instructions: session.instructions,
    model: session.model,
    response: session.response,
    store: session.store,
    tools: session.tools,
    toolCallItems: [...(session.toolCallItems ?? [])],
  };
}

/**
 * Accepts a session read back from disk only when the fields the continuation
 * logic dereferences are present, so a hand-edited or truncated file costs the
 * affected chains rather than the whole store.
 */
function reviveOpenAIResponsesSession(value: unknown): OpenAIResponsesSession | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const inputItems = Reflect.get(value, 'inputItems');
  const model = Reflect.get(value, 'model');
  if (!Array.isArray(inputItems) || typeof model !== 'string' || !model) {
    return null;
  }
  return cloneOpenAIResponsesSession(value as OpenAIResponsesSession);
}

/**
 * Rebuilds a Responses transcript using the same continuation rules used by
 * Codex clients: compaction replaces stale history, orphan tool outputs recover
 * their calls from the session cache, and repeated durable items are removed.
 */
export function mergeOpenAIResponsesInputItems(
  history: unknown[],
  newInput: unknown[],
  cachedToolCalls: unknown[] = [],
): unknown[] {
  const filteredHistory = history.filter((item) => !isCodexTranscriptOnlyAssistantMessage(item));
  const filteredNewInput = newInput.filter((item) => !isCodexTranscriptOnlyAssistantMessage(item));
  const hasCompaction = filteredNewInput.some(isCompactionItem);
  const merged = hasCompaction
    ? filteredNewInput.filter((item) => !isCompactionItem(item))
    : [...filteredHistory, ...filteredNewInput.filter((item) => !isCompactionItem(item))];

  return dedupeFunctionCallsByCallId(
    dedupeInputItemsById(repairToolCalls(merged, cachedToolCalls)),
  );
}

function isCodexTranscriptOnlyAssistantMessage(item: unknown): boolean {
  if (getStringField(item, 'type') !== 'message' || getStringField(item, 'role') !== 'assistant') {
    return false;
  }

  const phase = getStringField(item, 'phase');
  const itemId = getStringField(item, 'id');
  if (phase === 'commentary' || itemId?.startsWith('msg_thought_')) {
    return true;
  }

  return getMessageText(item).trimStart().startsWith('**Thinking**');
}

function getMessageText(item: unknown): string {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return '';
  }
  const content = Reflect.get(item, 'content');
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (typeof part !== 'object' || part === null || Array.isArray(part)) {
        return '';
      }
      const text = Reflect.get(part, 'text');
      return typeof text === 'string' ? text : '';
    })
    .join('');
}

function repairToolCalls(items: unknown[], cachedToolCalls: unknown[]): unknown[] {
  const presentCallIds = new Set(
    items
      .filter(isToolCallItem)
      .map(getCallId)
      .filter((callId): callId is string => Boolean(callId)),
  );
  const cacheByCallId = new Map<string, unknown>();
  for (const item of cachedToolCalls) {
    if (!isToolCallItem(item)) {
      continue;
    }
    const callId = getCallId(item);
    if (callId) {
      cacheByCallId.set(callId, item);
    }
  }

  const inserted = new Set<string>();
  const repaired: unknown[] = [];
  for (const item of items) {
    if (isToolCallOutputItem(item)) {
      const callId = getCallId(item);
      if (callId && !presentCallIds.has(callId) && !inserted.has(callId)) {
        const cachedCall = cacheByCallId.get(callId);
        if (cachedCall) {
          repaired.push(cachedCall);
          inserted.add(callId);
        }
      }
    }
    repaired.push(item);
  }
  return repaired;
}

function dedupeInputItemsById(items: unknown[]): unknown[] {
  const referencedCallIds = new Set(
    items
      .filter(isToolCallOutputItem)
      .map(getCallId)
      .filter((callId): callId is string => Boolean(callId)),
  );
  const keepByItemId = new Map<string, { index: number; referenced: boolean }>();

  items.forEach((item, index) => {
    const itemId = getStringField(item, 'id');
    if (!itemId) {
      return;
    }
    const callId = getCallId(item);
    const referenced = Boolean(callId && referencedCallIds.has(callId));
    const existing = keepByItemId.get(itemId);
    if (!existing || referenced || !existing.referenced) {
      keepByItemId.set(itemId, { index, referenced });
    }
  });

  const keepIndexes = new Set([...keepByItemId.values()].map(({ index }) => index));
  return items.filter((item, index) => {
    const itemId = getStringField(item, 'id');
    return !itemId || keepIndexes.has(index);
  });
}

function dedupeFunctionCallsByCallId(items: unknown[]): unknown[] {
  const seenCallIds = new Set<string>();
  return items.filter((item) => {
    if (!isToolCallItem(item)) {
      return true;
    }
    const callId = getCallId(item);
    if (!callId) {
      return true;
    }
    if (seenCallIds.has(callId)) {
      return false;
    }
    seenCallIds.add(callId);
    return true;
  });
}

function collectResponsesToolCallItems(items: unknown[]): unknown[] {
  return dedupeFunctionCallsByCallId(items.filter(isToolCallItem));
}

function isCompactionItem(item: unknown): boolean {
  const type = getStringField(item, 'type');
  return type === 'compaction' || type === 'compaction_summary';
}

function isToolCallItem(item: unknown): boolean {
  const type = getStringField(item, 'type');
  return type === 'function_call' || type === 'custom_tool_call';
}

function isToolCallOutputItem(item: unknown): boolean {
  const type = getStringField(item, 'type');
  return type === 'function_call_output' || type === 'custom_tool_call_output';
}

function getCallId(item: unknown): string | null {
  return getStringField(item, 'call_id') ?? getStringField(item, 'id');
}

function getStringField(item: unknown, field: string): string | null {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return null;
  }
  const value = Reflect.get(item, field);
  return typeof value === 'string' && value.length > 0 ? value : null;
}
