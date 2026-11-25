import { collectResponsesToolCallItems } from './responses-session-input';
export {
  mergeOpenAIResponsesInputItems,
  prepareOpenAIResponsesSessionInput,
  type PreparedOpenAIResponsesSessionInput,
} from './responses-session-input';

import { DurableRecordStore } from '@/shared/persistence/durable-record-store';
import { getTrafficAuditRequestContext } from '../../../../../modules/proxy-gateway/audit/traffic-audit-context';
import { boundResponsesInputItems } from './openai-responses-inline-media';
import {
  containsInlineResponsesMedia,
  containsResponsesMediaReference,
  hasInvalidResponsesMediaReference,
  OpenAIResponsesMediaStore,
  ResponsesMediaUnavailableError,
} from './openai-responses-media-store';
import { resolveClientSessionHint } from '../../../common/client-session-hint';
import type { OpenAIChatRequest } from '../../../common/interfaces/request-interfaces';
import { decodeResponsesHistoryOwner, type ResponsesHistoryOwner } from './responses-history-owner';
import {
  decodeResponsesInitialIdentity,
  type ResponsesInitialIdentity,
} from './responses-initial-identity';

export interface OpenAIResponsesSession {
  thoughtSessionKey?: string;
  identity: ResponsesInitialIdentity;
  historyOwner?: ResponsesHistoryOwner;
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
  readonly thoughtSessionKey?: string;
  readonly identity: ResponsesInitialIdentity;
  readonly historyOwner: ResponsesHistoryOwner;
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
  thoughtSessionKey?: string;
  identity: ResponsesInitialIdentity;
  historyOwner?: ResponsesHistoryOwner;
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
  getHistoryOwner(responseId: string): ResponsesHistoryOwner | null;
  clear(): void;
  delete(responseId: string): boolean;
  get(responseId: string): OpenAIResponsesSession | null;
  getWithParent(responseId: string): OpenAIResponsesSessionWithParent | null;
  save(responseId: string, session: OpenAIResponsesSession): void;
  saveDelta(responseId: string, delta: SaveOpenAIResponsesSessionDelta): void;
  saveDeltaWithMedia?(responseId: string, delta: SaveOpenAIResponsesSessionDelta): Promise<void>;
  getMediaStore?(): OpenAIResponsesMediaStore | undefined;
}

export interface OpenAIResponsesSessionStoreOptions {
  /** Absolute path of the backing file. Omit to keep the store in memory only. */
  filePath?: string;
  maxSessions?: number;
  mediaStore?: OpenAIResponsesMediaStore;
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
  private readonly fileBacked: boolean;
  private mediaStore?: OpenAIResponsesMediaStore;
  private readonly sessions: DurableRecordStore<StoredOpenAIResponsesSession>;
  private readonly revokedNodes = new WeakSet<OpenAIResponsesSessionNode>();
  private readonly issuedParents = new WeakSet<object>();

  public constructor(options: OpenAIResponsesSessionStoreOptions = {}) {
    this.fileBacked = options.filePath !== undefined;
    this.mediaStore = options.mediaStore;
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

  public getHistoryOwner(responseId: string): ResponsesHistoryOwner | null {
    return this.sessions.peek(responseId)?.node.historyOwner ?? null;
  }

  public getWithParent(responseId: string): OpenAIResponsesSessionWithParent | null {
    if (getTrafficAuditRequestContext()?.thoughtCaptureLease?.valid === false) {
      return null;
    }
    const stored = this.sessions.get(responseId);
    if (!stored) {
      return null;
    }

    const parent = createOpenAIResponsesSessionParent(stored.node);
    this.issuedParents.add(parent);
    return {
      parent,
      routingSessionId: normalizeRoutingSessionId(stored.node.routingSessionId) ?? responseId,
      session: materializeOpenAIResponsesSession(stored),
    };
  }

  public async restoreInputMedia(
    responseId: string,
  ): Promise<OpenAIResponsesSessionWithParent | null> {
    const materialized = this.getWithParent(responseId);
    if (!materialized) {
      return null;
    }
    if (!this.mediaStore) {
      if (containsResponsesMediaReference(materialized.session.inputItems)) {
        throw new ResponsesMediaUnavailableError();
      }
      return materialized;
    }
    const inputItems = await this.mediaStore.restore(materialized.session.inputItems);
    const source = sessionParentNodes.get(materialized.parent);
    if (
      !source ||
      this.revokedNodes.has(source) ||
      getTrafficAuditRequestContext()?.thoughtCaptureLease?.valid === false
    ) {
      throw new ResponsesMediaUnavailableError();
    }
    return {
      ...materialized,
      session: {
        ...materialized.session,
        inputItems,
      },
    };
  }

  public async storeInputMedia(items: unknown[]): Promise<unknown[]> {
    if (this.mediaStore) {
      return this.mediaStore.externalize(items);
    }
    if (this.fileBacked && containsInlineResponsesMedia(items)) {
      throw new Error('Private Responses media storage is not configured');
    }
    return cloneResponsesItems(items);
  }

  public async storeResponseMedia(
    response: Record<string, unknown> | undefined,
  ): Promise<Record<string, unknown> | undefined> {
    if (!response) {
      return undefined;
    }
    const [stored] = await this.storeInputMedia([response]);
    if (!isRecord(stored)) {
      throw new Error('Stored Responses response is invalid');
    }
    return stored;
  }

  public async restoreResponseMedia(
    response: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.mediaStore) {
      if (containsResponsesMediaReference(response)) {
        throw new ResponsesMediaUnavailableError();
      }
      return structuredClone(response);
    }
    const [restored] = await this.mediaStore.restore([response]);
    if (!isRecord(restored)) {
      throw new ResponsesMediaUnavailableError();
    }
    return restored;
  }

  public getMediaStore(): OpenAIResponsesMediaStore | undefined {
    return this.mediaStore;
  }

  public async saveDeltaWithMedia(
    responseId: string,
    delta: SaveOpenAIResponsesSessionDelta,
  ): Promise<void> {
    const captureLease = getTrafficAuditRequestContext()?.thoughtCaptureLease;
    const mayCommit = () => captureLease?.valid !== false;
    if (!mayCommit()) {
      return;
    }
    if (!this.fileBacked || delta.store === false) {
      this.saveDelta(responseId, delta);
      return;
    }
    const [inputDelta, responseOutput, toolCallItems, response] = await Promise.all([
      this.storeInputMedia(delta.inputDelta),
      this.storeInputMedia(delta.responseOutput),
      this.storeInputMedia(delta.toolCallItems ?? []),
      this.storeResponseMedia(delta.response),
    ]);
    if (!mayCommit()) {
      return;
    }
    const writeGeneration = this.saveDelta(responseId, {
      ...delta,
      inputDelta,
      responseOutput,
      response,
      toolCallItems,
    });
    if (
      writeGeneration !== undefined &&
      containsResponsesMediaReference([inputDelta, responseOutput, toolCallItems, response])
    ) {
      await this.sessions.flushStrict(writeGeneration);
    }
  }

  public save(responseId: string, session: OpenAIResponsesSession): void {
    const context = getTrafficAuditRequestContext();
    if (context?.thoughtCaptureLease?.valid === false) {
      return;
    }
    const boundedInputItems = boundResponsesInputItems(session.inputItems);
    const boundedToolCallItems = boundResponsesInputItems(session.toolCallItems ?? []);
    this.assertPersistableMedia([boundedInputItems, boundedToolCallItems, session.response]);
    this.sessions.set(responseId, {
      node: createOpenAIResponsesSessionNode({
        thoughtSessionKey: context?.thoughtSessionKey ?? session.thoughtSessionKey,
        identity: session.identity,
        historyOwner: session.historyOwner ?? 'unknown',
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

  public saveDelta(responseId: string, delta: SaveOpenAIResponsesSessionDelta): number | undefined {
    const context = getTrafficAuditRequestContext();
    if (context?.thoughtCaptureLease?.valid === false) {
      return undefined;
    }
    const parentNode = delta.parent ? sessionParentNodes.get(delta.parent) : undefined;
    if (delta.parent && (!parentNode || !this.issuedParents.has(delta.parent))) {
      throw new Error('Invalid OpenAI Responses session parent');
    }
    if (parentNode && parentNode.historyOwner !== (delta.historyOwner ?? 'unknown')) {
      throw new Error('OpenAI Responses session parent ownership mismatch');
    }
    for (let ancestor = parentNode; ancestor; ancestor = ancestor.parent ?? undefined) {
      if (this.revokedNodes.has(ancestor)) {
        throw new Error('Responses history parent was invalidated');
      }
    }
    const inputDelta = boundResponsesInputItems(delta.inputDelta);
    const responseOutput = boundResponsesInputItems(delta.responseOutput);
    const toolCallItems = boundResponsesInputItems(delta.toolCallItems ?? []);
    this.assertPersistableMedia([inputDelta, responseOutput, toolCallItems, delta.response]);
    return this.sessions.set(responseId, {
      node: createOpenAIResponsesSessionNode({
        thoughtSessionKey:
          parentNode?.thoughtSessionKey ?? context?.thoughtSessionKey ?? delta.thoughtSessionKey,
        identity: delta.identity,
        historyOwner: delta.historyOwner ?? 'unknown',
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
    for (const record of this.sessions.entries()) {
      this.revokedNodes.add(record.value.node);
    }
    this.sessions.clear();
  }

  /** Exact captured client ownership; old unknown rows are never assigned by similarity. */
  public async deleteThoughtSession(
    sessionKey?: string,
  ): Promise<{ removed: number; unknown: number }> {
    let removed = 0;
    let unknown = 0;
    for (const record of this.sessions.entries()) {
      if (sessionKey === undefined || record.value.node.thoughtSessionKey === sessionKey) {
        this.revokedNodes.add(record.value.node);
        if (this.sessions.delete(record.key)) {
          removed += 1;
        }
      } else if (record.value.node.thoughtSessionKey === undefined) {
        unknown += 1;
      }
    }
    await this.sessions.flushStrict();
    return { removed, unknown };
  }

  public onModuleDestroy(): void {
    this.replaceMediaStore();
  }

  protected replaceMediaStore(mediaStore?: OpenAIResponsesMediaStore): void {
    this.mediaStore?.dispose();
    this.mediaStore = mediaStore;
  }

  /** Resolves once every pending write has reached the disk. */
  public flush(): Promise<void> {
    return this.sessions.flush();
  }

  public flushStrict(): Promise<void> {
    return this.sessions.flushStrict();
  }

  private assertPersistableMedia(values: unknown[]): void {
    if (
      !this.fileBacked ||
      (!containsInlineResponsesMedia(values) && !hasInvalidResponsesMediaReference(values))
    ) {
      return;
    }
    throw new Error('Responses history must contain valid private media references before saving');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    ...(session.thoughtSessionKey === undefined
      ? {}
      : { thoughtSessionKey: session.thoughtSessionKey }),
    identity: Object.freeze({ ...session.identity }),
    historyOwner: session.historyOwner ?? 'unknown',
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
    identity: Object.freeze({ ...node.identity }),
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
    thoughtSessionKey: stored.node.thoughtSessionKey,
    identity: stored.node.identity,
    historyOwner: stored.node.historyOwner,
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
  if (!storedNode) {
    return null;
  }
  return {
    node: storedNode,
    response: reviveStoredResponse(Reflect.get(value, 'response')),
    store: reviveStoredBoolean(Reflect.get(value, 'store')),
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
    const historyOwner = decodeResponsesHistoryOwner(Reflect.get(current, 'historyOwner'));
    const thoughtSessionKey: unknown = Reflect.get(current, 'thoughtSessionKey');
    const identity = decodeResponsesInitialIdentity(Reflect.get(current, 'identity'));
    const routingSessionId = normalizeRoutingSessionId(Reflect.get(current, 'routingSessionId'));
    if (
      !Array.isArray(inputDelta) ||
      !Array.isArray(responseOutput) ||
      typeof model !== 'string' ||
      !model ||
      historyOwner === null ||
      (thoughtSessionKey !== undefined &&
        (typeof thoughtSessionKey !== 'string' ||
          !thoughtSessionKey ||
          thoughtSessionKey.length > 512)) ||
      identity === null ||
      containsInlineResponsesMedia([inputDelta, responseOutput]) ||
      hasInvalidResponsesMediaReference([inputDelta, responseOutput]) ||
      (identity.origin === 'client' && routingSessionId === undefined)
    ) {
      return null;
    }
    const rawToolCallItems = Reflect.get(current, 'toolCallItems');
    serializedChain.push({
      ...(typeof thoughtSessionKey === 'string' ? { thoughtSessionKey } : {}),
      identity,
      historyOwner,
      inputDelta: boundResponsesInputItems(inputDelta),
      instructions:
        typeof Reflect.get(current, 'instructions') === 'string'
          ? (Reflect.get(current, 'instructions') as string)
          : undefined,
      model,
      responseOutput: boundResponsesInputItems(responseOutput),
      routingSessionId,
      tools: Reflect.get(current, 'tools') as OpenAIChatRequest['tools'],
      toolCallItems: boundResponsesInputItems(
        Array.isArray(rawToolCallItems) ? rawToolCallItems : [],
      ),
    });
    const lastNode = serializedChain[serializedChain.length - 1];
    if (
      lastNode &&
      (containsInlineResponsesMedia(lastNode.toolCallItems) ||
        hasInvalidResponsesMediaReference(lastNode.toolCallItems))
    ) {
      return null;
    }
    current = Reflect.get(current, 'parent');
  }

  const owner = serializedChain[0]?.historyOwner;
  if (serializedChain.some((node) => node.historyOwner !== owner)) {
    return null;
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

function normalizeRoutingSessionId(value: unknown): string | undefined {
  return resolveClientSessionHint({}, undefined, { session_id: value }).id;
}
