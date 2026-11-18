import {
  repairToolCalls,
  isToolCallItem,
  isToolCallOutputItem,
  getCallId,
  getStringField,
  type ResponsesToolCallCache,
} from './responses-tool-call-repair';
import { isEqual } from 'lodash-es';
import { InvalidToolResultAssociationError } from '@/modules/proxy-gateway/antigravity/ClaudeToolResultAssociation';

import { resolveResponsesInputType } from './responses-input-type';
import { normalizeResponsesToolCallIds } from './responses-tool-call-identity';

/**
 * Rebuilds a Responses transcript using the same continuation rules used by
 * Codex clients: compaction replaces stale history, orphan tool outputs recover
 * their calls from the session cache, and repeated durable items are removed.
 */
export function mergeOpenAIResponsesInputItems(
  history: unknown[],
  newInput: unknown[],
  cachedToolCalls: ResponsesToolCallCache = [],
): unknown[] {
  const normalized = normalizeResponsesToolCallIds(
    mergeRawResponsesInputItems(history, newInput, cachedToolCalls),
  ).items;
  validatePendingToolCallIds(normalized);
  return normalized;
}

function mergeRawResponsesInputItems(
  history: unknown[],
  newInput: unknown[],
  cachedToolCalls: ResponsesToolCallCache = [],
): unknown[] {
  const filteredHistory = history.filter((item) => !isCodexTranscriptOnlyItem(item));
  const filteredNewInput = newInput.filter((item) => !isCodexTranscriptOnlyItem(item));
  const hasCompaction = filteredNewInput.some(isCompactionItem);
  const merged = hasCompaction
    ? filteredNewInput.filter((item) => !isCompactionItem(item))
    : [...filteredHistory, ...filteredNewInput.filter((item) => !isCompactionItem(item))];

  return dedupeInputItemsById(repairToolCalls(merged, cachedToolCalls));
}

export interface PreparedOpenAIResponsesSessionInput {
  delta: unknown[];
  merged: unknown[];
  resetParent: boolean;
}

/** Derives the retained suffix while rebuilding the complete input needed by the provider. */
export function prepareOpenAIResponsesSessionInput(
  history: unknown[],
  newInput: unknown[],
  cachedToolCalls: unknown[] = [],
  retainDelta = true,
): PreparedOpenAIResponsesSessionInput {
  const resetParent = newInput.some(isCompactionItem);
  const exactReplay = history.length > 0 && startsWithItems(newInput, history);
  const semanticPrefixReplay =
    history.length > 0 &&
    newInput.length >= history.length &&
    history.every((item, index) => responsesItemsSemanticallyEqual(item, newInput[index]));
  const replayedThrough =
    resetParent || exactReplay || semanticPrefixReplay
      ? -1
      : findLastSharedItemId(history, newInput);
  const semanticSuffixIndex =
    history.length > 0 &&
    !resetParent &&
    !exactReplay &&
    !semanticPrefixReplay &&
    replayedThrough < 0
      ? findLastSemanticItemIndex(newInput, history[history.length - 1])
      : -1;
  let useNewInputAsMerged = false;
  let deltaSource: unknown[];
  if (resetParent || history.length === 0) {
    deltaSource = [...newInput];
  } else if (exactReplay || semanticPrefixReplay) {
    deltaSource = newInput.slice(history.length);
  } else if (replayedThrough >= 0) {
    deltaSource = newInput.slice(replayedThrough + 1);
  } else if (semanticSuffixIndex >= 0) {
    deltaSource = newInput.slice(semanticSuffixIndex + 1);
  } else if (newInput.length >= history.length) {
    deltaSource = newInput.length > 0 ? [newInput[newInput.length - 1]] : [];
    useNewInputAsMerged = true;
  } else {
    deltaSource = [...newInput];
  }
  // A continuation repairs against the complete parent history, not an isolated delta
  // that would copy the parent's pending call into both the request and durable lineage.
  const delta = mergeRawResponsesInputItems(
    [],
    deltaSource,
    resetParent || history.length === 0 ? cachedToolCalls : [],
  );
  const merged =
    resetParent || history.length === 0
      ? [...delta]
      : useNewInputAsMerged
        ? mergeRawResponsesInputItems([], newInput, cachedToolCalls)
        : mergeRawResponsesInputItems(history, delta, cachedToolCalls);
  const normalized = normalizeResponsesToolCallIds(merged, retainDelta ? delta : []);
  validatePendingToolCallIds(normalized.items);
  return { delta: normalized.delta, merged: normalized.items, resetParent };
}

function startsWithItems(items: unknown[], prefix: unknown[]): boolean {
  return prefix.every((item, index) => isEqual(items[index], item));
}

function findLastSharedItemId(history: unknown[], newInput: unknown[]): number {
  const historyIds = new Set(history.map(resolveItemId).filter((id): id is string => Boolean(id)));
  for (let index = newInput.length - 1; index >= 0; index -= 1) {
    const id = resolveItemId(newInput[index]);
    if (id && historyIds.has(id)) {
      return index;
    }
  }
  return -1;
}

function findLastSemanticItemIndex(items: unknown[], expected: unknown): number {
  // Tool payloads can repeat across completed rounds; they are not causal replay anchors.
  if (isToolCallItem(expected) || isToolCallOutputItem(expected)) {
    return -1;
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (responsesItemsSemanticallyEqual(items[index], expected)) {
      return index;
    }
  }
  return -1;
}

function responsesItemsSemanticallyEqual(left: unknown, right: unknown): boolean {
  if (!isResponsesItemRecord(left) || !isResponsesItemRecord(right)) {
    return isEqual(left, right);
  }
  if (
    resolveResponsesInputType(left) !== 'message' ||
    resolveResponsesInputType(right) !== 'message'
  ) {
    return isEqual(left, right);
  }

  return (
    isEqual(Reflect.get(left, 'role'), Reflect.get(right, 'role')) &&
    isEqual(Reflect.get(left, 'type'), Reflect.get(right, 'type')) &&
    isEqual(resolveSemanticItemContent(left), resolveSemanticItemContent(right))
  );
}

function resolveSemanticItemContent(item: Record<PropertyKey, unknown>): unknown {
  return Object.prototype.hasOwnProperty.call(item, 'content')
    ? Reflect.get(item, 'content')
    : Reflect.get(item, 'text');
}

function isResponsesItemRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveItemId(item: unknown): string | undefined {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return undefined;
  }
  const id = Reflect.get(item, 'id');
  return typeof id === 'string' && id ? id : undefined;
}

function isCodexTranscriptOnlyItem(item: unknown): boolean {
  const inputType = resolveResponsesInputType(item);
  if (inputType === 'reasoning') {
    return true;
  }

  if (inputType !== 'message' || getStringField(item, 'role') !== 'assistant') {
    return false;
  }

  const itemId = getStringField(item, 'id');
  if (itemId?.startsWith('msg_thought_')) {
    return true;
  }

  if (getMessageText(item).trimStart().startsWith('**Thinking**')) {
    return true;
  }

  // A provider can use the Responses phase field for visible progress updates. Preserve those
  // messages unless the item also carries one of the explicit local transcript markers above.
  return false;
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
    .flatMap((part) => {
      if (typeof part !== 'object' || part === null || Array.isArray(part)) {
        return [];
      }
      const text = Reflect.get(part, 'text');
      return typeof text === 'string' ? [text] : [];
    })
    .join('\n');
}

function dedupeInputItemsById(items: unknown[]): unknown[] {
  const firstByItemId = new Map<string, unknown>();
  return items.filter((item, index) => {
    const itemId = getStringField(item, 'id');
    if (!itemId) {
      return true;
    }
    if (!firstByItemId.has(itemId)) {
      firstByItemId.set(itemId, item);
      return true;
    }
    if (!isEqual(firstByItemId.get(itemId), item)) {
      throw new InvalidToolResultAssociationError(`input[${index}]`, 'conflicting-item-id');
    }
    return false;
  });
}

function validatePendingToolCallIds(items: unknown[]): void {
  const pending = new Set<string>();
  for (const [index, item] of items.entries()) {
    const callId = getCallId(item);
    if (!callId) {
      continue;
    }
    if (isToolCallOutputItem(item)) {
      pending.delete(callId);
    } else if (isToolCallItem(item)) {
      if (pending.has(callId)) {
        throw new InvalidToolResultAssociationError(`input[${index}]`, 'duplicate-pending-id');
      }
      pending.add(callId);
    }
  }
}

export function collectResponsesToolCallItems(items: unknown[]): unknown[] {
  const candidates = new Map<string, unknown[]>();
  return items.filter((item) => {
    if (!isToolCallItem(item)) {
      return false;
    }
    const callId = getCallId(item);
    if (!callId) {
      return true;
    }
    const existing = candidates.get(callId) ?? [];
    // Two distinct witnesses suffice to reject ambiguous recovery; retaining every round
    // would grow cache payloads and make repeated lineage materialization quadratic.
    if (existing.length === 2 || existing.some((candidate) => isEqual(candidate, item))) {
      return false;
    }
    existing.push(item);
    candidates.set(callId, existing);
    return true;
  });
}

function isCompactionItem(item: unknown): boolean {
  const type = getStringField(item, 'type');
  return type === 'compaction' || type === 'compaction_summary';
}
