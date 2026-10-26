import { isEqual } from 'lodash-es';
import { InvalidToolResultAssociationError } from '@/modules/proxy-gateway/antigravity/ClaudeToolResultAssociation';

/** Durable histories carry arrays; a live socket already owns an index keyed by call ID. */
export type ResponsesToolCallCache = unknown[] | ReadonlyMap<string, unknown>;

const ambiguousCachedCall = Symbol('ambiguous Responses tool call');

/** Preserve ambiguity without retaining another full call payload in a live socket. */
export function rememberResponsesToolCall(cache: Map<string, unknown>, item: unknown): void {
  if (!isToolCallItem(item)) {
    return;
  }
  const callId = getCallId(item);
  if (!callId) {
    return;
  }
  const existing = cache.get(callId);
  cache.set(callId, cache.has(callId) && !isEqual(existing, item) ? ambiguousCachedCall : item);
}

export function repairToolCalls(
  items: unknown[],
  cachedToolCalls: ResponsesToolCallCache,
): unknown[] {
  let cacheByCallId: ReadonlyMap<string, unknown>;
  if (Array.isArray(cachedToolCalls)) {
    const index = new Map<string, unknown>();
    for (const item of cachedToolCalls) {
      rememberResponsesToolCall(index, item);
    }
    cacheByCallId = index;
  } else {
    // The socket owns this index. Looking up missing calls must not enumerate its full history.
    cacheByCallId = cachedToolCalls;
  }
  const seenCallIds = new Set<string>();
  const repaired: unknown[] = [];
  for (const [position, item] of items.entries()) {
    const callId = getCallId(item);
    if (isToolCallItem(item) && callId) {
      seenCallIds.add(callId);
    }
    if (isToolCallOutputItem(item)) {
      if (callId && !seenCallIds.has(callId)) {
        const cachedCall = cacheByCallId.get(callId);
        if (cachedCall === ambiguousCachedCall) {
          throw new InvalidToolResultAssociationError(
            `input[${position}]`,
            'ambiguous-cached-call',
          );
        }
        if (cachedCall) {
          repaired.push(cachedCall);
          // A consumed call cannot be repaired again for a repeated result.
          seenCallIds.add(callId);
        }
      }
    }
    repaired.push(item);
  }
  return repaired;
}

export function isToolCallItem(item: unknown): boolean {
  const type = getStringField(item, 'type');
  return type === 'function_call' || type === 'custom_tool_call';
}

export function isToolCallOutputItem(item: unknown): boolean {
  const type = getStringField(item, 'type');
  return type === 'function_call_output' || type === 'custom_tool_call_output';
}

export function getCallId(item: unknown): string | null {
  return getStringField(item, 'call_id') ?? getStringField(item, 'id');
}

export function getStringField(item: unknown, field: string): string | null {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return null;
  }
  const value = Reflect.get(item, field);
  return typeof value === 'string' && value.length > 0 ? value : null;
}
