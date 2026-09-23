import { isEqual } from 'lodash-es';

import { DurableRecordStore } from '@/shared/persistence/durable-record-store';
import { resolveResponsesInputType } from './responses-input-type';
import { boundResponsesInputItems } from './openai-responses-inline-media';
import type { OpenAIChatRequest } from '../../../common/interfaces/request-interfaces';

export interface OpenAIResponsesSession {
  inputItems: unknown[];
  instructions?: string;
  model: string;
  /** Stable account-routing identity shared by every response in one lineage. */
  routingSessionId?: string;
  /** The completed Responses payload, so `GET /v1/responses/{id}` can replay it. */
  response?: Record<string, unknown>;
  /** What the request asked for. `false` means the payload is never retained. */
  store?: boolean;
  tools?: OpenAIChatRequest['tools'];
  toolCallItems?: unknown[];
}

interface OpenAIResponsesSessionNode {
  readonly parent: OpenAIResponsesSessionNode | null;
  readonly inputDelta: readonly unknown[];
  readonly responseOutput: readonly unknown[];
  readonly instructions?: string;
  readonly model: string;
  readonly routingSessionId?: string;
  readonly tools?: OpenAIChatRequest['tools'];
  readonly toolCallItems: readonly unknown[];
}

interface StoredOpenAIResponsesSession {
  readonly node: OpenAIResponsesSessionNode;
  readonly response?: Record<string, unknown>;
  readonly store?: boolean;
}

declare const openAIResponsesSessionParentBrand: unique symbol;

/** Opaque strong reference to an immutable Responses history node. */
export interface OpenAIResponsesSessionParent {
  readonly [openAIResponsesSessionParentBrand]: true;
}

export interface OpenAIResponsesSessionWithParent {
  parent: OpenAIResponsesSessionParent;
  routingSessionId: string;
  session: OpenAIResponsesSession;
}

export interface SaveOpenAIResponsesSessionDelta {
  inputDelta: unknown[];
  instructions?: string;
  model: string;
  parent?: OpenAIResponsesSessionParent | null;
  response?: Record<string, unknown>;
  responseOutput: unknown[];
  routingSessionId?: string;
  store?: boolean;
  tools?: OpenAIChatRequest['tools'];
  toolCallItems?: unknown[];
}

const sessionParentNodes = new WeakMap<object, OpenAIResponsesSessionNode>();

/** What the Responses surface needs from the store, so a caller can be handed either. */
export interface OpenAIResponsesSessionStoreLike {
  clear(): void;
  delete(responseId: string): boolean;
  get(responseId: string): OpenAIResponsesSession | null;
  getWithParent(responseId: string): OpenAIResponsesSessionWithParent | null;
  save(responseId: string, session: OpenAIResponsesSession): void;
  saveDelta(responseId: string, delta: SaveOpenAIResponsesSessionDelta): void;
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
  private readonly sessions: DurableRecordStore<StoredOpenAIResponsesSession>;

  public constructor(options: OpenAIResponsesSessionStoreOptions = {}) {
    this.sessions = new DurableRecordStore<StoredOpenAIResponsesSession>({
      filePath: options.filePath,
      maxEntries: options.maxSessions ?? DEFAULT_OPENAI_RESPONSES_MAX_SESSIONS,
      ttlMs: options.ttlMs ?? DEFAULT_OPENAI_RESPONSES_SESSION_TTL_MS,
      revive: reviveStoredOpenAIResponsesSession,
    });
  }

  public get(responseId: string): OpenAIResponsesSession | null {
    return this.getWithParent(responseId)?.session ?? null;
  }

  public getWithParent(responseId: string): OpenAIResponsesSessionWithParent | null {
    const stored = this.sessions.get(responseId);
    if (!stored) {
      return null;
    }

    return {
      parent: createOpenAIResponsesSessionParent(stored.node),
      routingSessionId: normalizeRoutingSessionId(stored.node.routingSessionId) ?? responseId,
      session: materializeOpenAIResponsesSession(stored),
    };
  }

  public save(responseId: string, session: OpenAIResponsesSession): void {
    const boundedInputItems = boundResponsesInputItems(session.inputItems);
    const boundedToolCallItems = boundResponsesInputItems(session.toolCallItems ?? []);
    this.sessions.set(responseId, {
      node: createOpenAIResponsesSessionNode({
        inputDelta: boundedInputItems,
        instructions: session.instructions,
        model: session.model,
        parent: null,
        responseOutput: [],
        routingSessionId: normalizeRoutingSessionId(session.routingSessionId) ?? responseId,
        tools: session.tools,
        toolCallItems: collectResponsesToolCallItems([
          ...boundedToolCallItems,
          ...boundedInputItems,
        ]),
      }),
      response: cloneStoredResponse(session.response),
      store: session.store,
    });
  }

  public saveDelta(responseId: string, delta: SaveOpenAIResponsesSessionDelta): void {
    const parentNode = delta.parent ? sessionParentNodes.get(delta.parent) : undefined;
    if (delta.parent && !parentNode) {
      throw new Error('Invalid OpenAI Responses session parent');
    }
    const inputDelta = boundResponsesInputItems(delta.inputDelta);
    const responseOutput = boundResponsesInputItems(delta.responseOutput);
    const toolCallItems = boundResponsesInputItems(delta.toolCallItems ?? []);
    this.sessions.set(responseId, {
      node: createOpenAIResponsesSessionNode({
        inputDelta,
        instructions: delta.instructions,
        model: delta.model,
        parent: parentNode ?? null,
        responseOutput,
        routingSessionId: normalizeRoutingSessionId(delta.routingSessionId) ?? responseId,
        tools: delta.tools,
        toolCallItems: collectResponsesToolCallItems([
          ...toolCallItems,
          ...inputDelta,
          ...responseOutput,
        ]),
      }),
      response: cloneStoredResponse(delta.response),
      store: delta.store,
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
    inputItems: cloneResponsesItems(session.inputItems),
    instructions: session.instructions,
    model: session.model,
    routingSessionId: session.routingSessionId,
    response: cloneStoredResponse(session.response),
    store: session.store,
    tools: cloneResponsesTools(session.tools),
    toolCallItems: cloneResponsesItems(session.toolCallItems ?? []),
  };
}

function createOpenAIResponsesSessionParent(
  node: OpenAIResponsesSessionNode,
): OpenAIResponsesSessionParent {
  const parent = Object.freeze({}) as OpenAIResponsesSessionParent;
  sessionParentNodes.set(parent, node);
  return parent;
}

function createOpenAIResponsesSessionNode(
  node: OpenAIResponsesSessionNode,
): OpenAIResponsesSessionNode {
  return Object.freeze({
    ...node,
    inputDelta: Object.freeze(cloneResponsesItems(node.inputDelta)),
    responseOutput: Object.freeze(cloneResponsesItems(node.responseOutput)),
    tools: cloneResponsesTools(node.tools),
    toolCallItems: Object.freeze(cloneResponsesItems(node.toolCallItems)),
  });
}

function materializeOpenAIResponsesSession(
  stored: StoredOpenAIResponsesSession,
): OpenAIResponsesSession {
  const chain: OpenAIResponsesSessionNode[] = [];
  for (let node: OpenAIResponsesSessionNode | null = stored.node; node; node = node.parent) {
    chain.push(node);
  }

  const inputItems = chain
    .reverse()
    .flatMap((node) => cloneResponsesItems([...node.inputDelta, ...node.responseOutput]));
  const toolCallItems = collectResponsesToolCallItems([
    ...chain.flatMap((node) => node.toolCallItems),
    ...inputItems,
  ]);

  return sanitizeOpenAIResponsesSession({
    inputItems,
    instructions: stored.node.instructions,
    model: stored.node.model,
    routingSessionId: stored.node.routingSessionId,
    response: cloneStoredResponse(stored.response),
    store: stored.store,
    tools: cloneResponsesTools(stored.node.tools),
    toolCallItems,
  });
}

/**
 * Accepts a session read back from disk only when the fields the continuation
 * logic dereferences are present, so a hand-edited or truncated file costs the
 * affected chains rather than the whole store.
 */
function reviveStoredOpenAIResponsesSession(value: unknown): StoredOpenAIResponsesSession | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const storedNode = reviveOpenAIResponsesSessionNode(Reflect.get(value, 'node'));
  if (storedNode) {
    return {
      node: storedNode,
      response: reviveStoredResponse(Reflect.get(value, 'response')),
      store: reviveStoredBoolean(Reflect.get(value, 'store')),
    };
  }

  const inputItems = Reflect.get(value, 'inputItems');
  const model = Reflect.get(value, 'model');
  if (!Array.isArray(inputItems) || typeof model !== 'string' || !model) {
    return null;
  }
  const legacy = sanitizeOpenAIResponsesSession(value as OpenAIResponsesSession);
  const boundedToolCallItems = boundResponsesInputItems(legacy.toolCallItems ?? []);
  return {
    node: createOpenAIResponsesSessionNode({
      inputDelta: legacy.inputItems,
      instructions: legacy.instructions,
      model: legacy.model,
      parent: null,
      responseOutput: [],
      routingSessionId: legacy.routingSessionId,
      tools: legacy.tools,
      toolCallItems: collectResponsesToolCallItems([...boundedToolCallItems, ...legacy.inputItems]),
    }),
    response: legacy.response,
    store: legacy.store,
  };
}

function reviveOpenAIResponsesSessionNode(value: unknown): OpenAIResponsesSessionNode | null {
  const serializedChain: Array<Omit<OpenAIResponsesSessionNode, 'parent'>> = [];
  let current = value;
  while (current != null) {
    if (typeof current !== 'object' || Array.isArray(current)) {
      return null;
    }
    const inputDelta = Reflect.get(current, 'inputDelta');
    const responseOutput = Reflect.get(current, 'responseOutput');
    const model = Reflect.get(current, 'model');
    if (
      !Array.isArray(inputDelta) ||
      !Array.isArray(responseOutput) ||
      typeof model !== 'string' ||
      !model
    ) {
      return null;
    }
    const rawToolCallItems = Reflect.get(current, 'toolCallItems');
    serializedChain.push({
      inputDelta: boundResponsesInputItems(inputDelta),
      instructions:
        typeof Reflect.get(current, 'instructions') === 'string'
          ? (Reflect.get(current, 'instructions') as string)
          : undefined,
      model,
      responseOutput: boundResponsesInputItems(responseOutput),
      routingSessionId: normalizeRoutingSessionId(Reflect.get(current, 'routingSessionId')),
      tools: Reflect.get(current, 'tools') as OpenAIChatRequest['tools'],
      toolCallItems: boundResponsesInputItems(
        Array.isArray(rawToolCallItems) ? rawToolCallItems : [],
      ),
    });
    current = Reflect.get(current, 'parent');
  }

  let parent: OpenAIResponsesSessionNode | null = null;
  for (const serialized of serializedChain.reverse()) {
    parent = createOpenAIResponsesSessionNode({ ...serialized, parent });
  }
  return parent;
}

function reviveStoredResponse(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function cloneStoredResponse(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return value ? structuredClone(value) : undefined;
}

function cloneResponsesTools(
  tools: OpenAIChatRequest['tools'] | undefined,
): OpenAIChatRequest['tools'] | undefined {
  return tools ? structuredClone(tools) : undefined;
}

function cloneResponsesItems(items: readonly unknown[]): unknown[] {
  return structuredClone([...items]);
}

function reviveStoredBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function sanitizeOpenAIResponsesSession(session: OpenAIResponsesSession): OpenAIResponsesSession {
  return cloneOpenAIResponsesSession({
    ...session,
    inputItems: boundResponsesInputItems(session.inputItems),
    toolCallItems: boundResponsesInputItems(session.toolCallItems ?? []),
  });
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
  const filteredHistory = history.filter((item) => !isCodexTranscriptOnlyItem(item));
  const filteredNewInput = newInput.filter((item) => !isCodexTranscriptOnlyItem(item));
  const hasCompaction = filteredNewInput.some(isCompactionItem);
  const merged = hasCompaction
    ? filteredNewInput.filter((item) => !isCompactionItem(item))
    : [...filteredHistory, ...filteredNewInput.filter((item) => !isCompactionItem(item))];

  return dedupeFunctionCallsByCallId(
    dedupeInputItemsById(repairToolCalls(merged, cachedToolCalls)),
  );
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
  const delta = mergeOpenAIResponsesInputItems([], deltaSource, cachedToolCalls);
  const merged =
    resetParent || history.length === 0
      ? [...delta]
      : useNewInputAsMerged
        ? mergeOpenAIResponsesInputItems([], newInput, cachedToolCalls)
        : mergeOpenAIResponsesInputItems(history, delta, cachedToolCalls);

  return { delta: retainDelta ? delta : [], merged, resetParent };
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
    .flatMap((part) => {
      if (typeof part !== 'object' || part === null || Array.isArray(part)) {
        return [];
      }
      const text = Reflect.get(part, 'text');
      return typeof text === 'string' ? [text] : [];
    })
    .join('\n');
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

function normalizeRoutingSessionId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
