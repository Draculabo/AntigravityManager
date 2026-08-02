import type { OpenAIChatRequest } from './interfaces/request-interfaces';

export interface OpenAIResponsesSession {
  inputItems: unknown[];
  instructions?: string;
  model: string;
  tools?: OpenAIChatRequest['tools'];
  toolCallItems?: unknown[];
}

interface StoredOpenAIResponsesSession extends OpenAIResponsesSession {
  updatedAt: number;
}

/**
 * Holds the HTTP-only state needed to support Responses API continuation.
 *
 * Gemini requires complete tool and assistant history, while Responses clients may
 * only send the next input with previous_response_id. Entries are intentionally
 * short-lived and bounded because this is compatibility state, not durable memory.
 */
class OpenAIResponsesSessionStoreImpl {
  private static readonly MAX_SESSIONS = 500;
  private static readonly SESSION_TTL_MS = 60 * 60 * 1000;

  private readonly sessions = new Map<string, StoredOpenAIResponsesSession>();

  public get(responseId: string): OpenAIResponsesSession | null {
    const session = this.sessions.get(responseId);
    if (!session) {
      return null;
    }
    if (Date.now() - session.updatedAt >= OpenAIResponsesSessionStoreImpl.SESSION_TTL_MS) {
      this.sessions.delete(responseId);
      return null;
    }

    session.updatedAt = Date.now();
    return {
      inputItems: [...session.inputItems],
      instructions: session.instructions,
      model: session.model,
      tools: session.tools,
      toolCallItems: [...(session.toolCallItems ?? [])],
    };
  }

  public save(responseId: string, session: OpenAIResponsesSession): void {
    this.evictExpired();
    const toolCallItems = collectResponsesToolCallItems([
      ...(session.toolCallItems ?? []),
      ...session.inputItems,
    ]);
    this.sessions.set(responseId, {
      ...session,
      inputItems: [...session.inputItems],
      toolCallItems,
      updatedAt: Date.now(),
    });
    this.evictOverflow();
  }

  public clear(): void {
    this.sessions.clear();
  }

  private evictExpired(): void {
    const oldestAllowed = Date.now() - OpenAIResponsesSessionStoreImpl.SESSION_TTL_MS;
    for (const [responseId, session] of this.sessions.entries()) {
      if (session.updatedAt < oldestAllowed) {
        this.sessions.delete(responseId);
      }
    }
  }

  private evictOverflow(): void {
    while (this.sessions.size > OpenAIResponsesSessionStoreImpl.MAX_SESSIONS) {
      const oldestResponseId = this.sessions.keys().next().value;
      if (!oldestResponseId) {
        return;
      }
      this.sessions.delete(oldestResponseId);
    }
  }
}

export const OpenAIResponsesSessionStore = new OpenAIResponsesSessionStoreImpl();

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
