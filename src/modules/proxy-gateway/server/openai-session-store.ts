import { isEmpty, isPlainObject, isString } from 'lodash-es';
import { Observable } from 'rxjs';
import type {
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIMessage,
  OpenAIToolCall,
} from './interfaces/request-interfaces';

interface SessionState {
  messages: OpenAIMessage[];
  lastAccessedAt: number;
}

export interface OpenAISessionStoreOptions {
  maxHistoryChars?: number;
  maxSessions?: number;
  sessionTtlMs?: number;
}

export interface PreparedOpenAISessionRequest {
  request: OpenAIChatRequest;
  sessionId?: string;
  shouldStore: boolean;
  newMessages: OpenAIMessage[];
  releaseSession: () => void;
}

interface MergeResult {
  messages: OpenAIMessage[];
  newMessages: OpenAIMessage[];
}

interface StreamAssistantAccumulator {
  content: string;
  toolCalls: Map<number, OpenAIToolCall>;
}

interface StreamToolCallDelta {
  index?: number;
  id?: unknown;
  type?: unknown;
  function?: {
    name?: unknown;
    arguments?: unknown;
  };
}

const DEFAULT_MAX_HISTORY_CHARS = 1_000_000;
const DEFAULT_MAX_SESSIONS = 64;
const DEFAULT_SESSION_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Adds opt-in state to the otherwise stateless OpenAI Chat Completions endpoint.
 * Clients that omit session_id continue to use the standard stateless contract.
 */
export class OpenAISessionStore {
  private readonly sessions = new Map<string, SessionState>();
  private readonly sessionTails = new Map<string, Promise<void>>();
  private readonly maxHistoryChars: number;
  private readonly maxSessions: number;
  private readonly sessionTtlMs: number;

  constructor(options: OpenAISessionStoreOptions = {}) {
    this.maxHistoryChars = options.maxHistoryChars ?? DEFAULT_MAX_HISTORY_CHARS;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  }

  async prepareRequest(request: OpenAIChatRequest): Promise<PreparedOpenAISessionRequest> {
    const sessionId = this.extractSessionId(request);
    if (!sessionId || this.isStoreDisabled(request)) {
      return {
        request,
        shouldStore: false,
        newMessages: [],
        releaseSession: () => undefined,
      };
    }

    const releaseSession = await this.acquireSession(sessionId);
    try {
      this.pruneExpiredSessions();
      if (this.shouldResetSession(request)) {
        this.sessions.delete(sessionId);
      }

      const state = this.getOrCreateSession(sessionId);
      const incomingMessages = [
        ...this.extractBootstrapMessages(request),
        ...this.cloneMessages(request.messages ?? []),
      ];
      const merged = this.mergeMessages(state.messages, incomingMessages);
      state.lastAccessedAt = Date.now();
      this.enforceMaxSessions();

      return {
        request: {
          ...request,
          messages: merged.messages,
          extra: this.cleanSessionControls(request.extra, sessionId),
        },
        sessionId,
        shouldStore: true,
        newMessages: merged.newMessages,
        releaseSession,
      };
    } catch (error) {
      releaseSession();
      throw error;
    }
  }

  recordResponse(prepared: PreparedOpenAISessionRequest, response: OpenAIChatResponse): void {
    try {
      const assistantMessage = this.assistantMessageFromResponse(response);
      this.commitMessages(prepared, assistantMessage ? [assistantMessage] : []);
    } finally {
      prepared.releaseSession();
    }
  }

  abandonRequest(prepared: PreparedOpenAISessionRequest): void {
    prepared.releaseSession();
  }

  recordStreamResponse(
    prepared: PreparedOpenAISessionRequest,
    stream: Observable<string>,
  ): Observable<string> {
    if (!prepared.shouldStore || !prepared.sessionId) {
      return stream;
    }

    return new Observable<string>((subscriber) => {
      const assistant: StreamAssistantAccumulator = {
        content: '',
        toolCalls: new Map<number, OpenAIToolCall>(),
      };
      const subscription = stream.subscribe({
        next: (chunk) => {
          this.accumulateStreamChunk(chunk, assistant);
          subscriber.next(chunk);
        },
        error: (error) => {
          prepared.releaseSession();
          subscriber.error(error);
        },
        complete: () => {
          try {
            const assistantMessage = this.assistantMessageFromStream(assistant);
            this.commitMessages(prepared, assistantMessage ? [assistantMessage] : []);
            subscriber.complete();
          } catch (error) {
            subscriber.error(error);
          } finally {
            prepared.releaseSession();
          }
        },
      });

      return () => {
        subscription.unsubscribe();
        prepared.releaseSession();
      };
    });
  }

  /**
   * Serialize turns within one conversation so every request observes the response from the
   * preceding turn. Separate session IDs retain full concurrency.
   */
  private async acquireSession(sessionId: string): Promise<() => void> {
    const previous = this.sessionTails.get(sessionId) ?? Promise.resolve();
    let resolveCurrent: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      resolveCurrent = resolve;
    });
    const tail = previous.then(() => current);
    this.sessionTails.set(sessionId, tail);
    await previous;

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      resolveCurrent();
      void tail.then(() => {
        if (this.sessionTails.get(sessionId) === tail) {
          this.sessionTails.delete(sessionId);
        }
      });
    };
  }

  private commitMessages(
    prepared: PreparedOpenAISessionRequest,
    assistantMessages: OpenAIMessage[],
  ): void {
    if (!prepared.shouldStore || !prepared.sessionId) {
      return;
    }

    this.pruneExpiredSessions();
    const state = this.getOrCreateSession(prepared.sessionId);
    state.messages = this.trimMessages([
      ...state.messages,
      ...this.cloneMessages(prepared.newMessages),
      ...this.cloneMessages(assistantMessages),
    ]);
    state.lastAccessedAt = Date.now();
    this.enforceMaxSessions();
  }

  private mergeMessages(stored: OpenAIMessage[], incoming: OpenAIMessage[]): MergeResult {
    const overlap = this.findSuffixPrefixOverlap(stored, incoming);
    const newMessages = incoming.slice(overlap);
    return {
      messages: this.trimMessages([...stored, ...newMessages]),
      newMessages,
    };
  }

  private findSuffixPrefixOverlap(stored: OpenAIMessage[], incoming: OpenAIMessage[]): number {
    const maxOverlap = Math.min(stored.length, incoming.length);
    for (let length = maxOverlap; length > 0; length -= 1) {
      const storedSlice = stored.slice(stored.length - length);
      const incomingSlice = incoming.slice(0, length);
      if (this.sameMessages(storedSlice, incomingSlice)) {
        return length;
      }
    }
    return 0;
  }

  private sameMessages(left: OpenAIMessage[], right: OpenAIMessage[]): boolean {
    return (
      left.length === right.length &&
      left.every((message, index) => this.fingerprint(message) === this.fingerprint(right[index]))
    );
  }

  private assistantMessageFromResponse(response: OpenAIChatResponse): OpenAIMessage | null {
    const message = response.choices?.[0]?.message;
    if (!message) {
      return null;
    }

    const content = isString(message.content) ? message.content : '';
    const toolCalls = this.cloneToolCalls(message.tool_calls);
    if (isEmpty(content.trim()) && isEmpty(toolCalls)) {
      return null;
    }
    return { role: 'assistant', content, tool_calls: toolCalls };
  }

  private assistantMessageFromStream(assistant: StreamAssistantAccumulator): OpenAIMessage | null {
    const toolCalls = [...assistant.toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, toolCall]) => toolCall)
      .filter((toolCall) => Boolean(toolCall.id && toolCall.function.name));
    if (isEmpty(assistant.content.trim()) && toolCalls.length === 0) {
      return null;
    }
    return {
      role: 'assistant',
      content: assistant.content,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  private accumulateStreamChunk(chunk: string, assistant: StreamAssistantAccumulator): void {
    for (const line of String(chunk).split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) {
        continue;
      }
      const payload = trimmed.slice(6).trim();
      if (!payload || payload === '[DONE]') {
        continue;
      }

      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{
            delta?: { content?: unknown; tool_calls?: StreamToolCallDelta[] };
          }>;
        };
        const delta = parsed.choices?.[0]?.delta;
        if (isString(delta?.content)) {
          assistant.content += delta.content;
        }
        for (const toolCallDelta of delta?.tool_calls ?? []) {
          this.accumulateToolCall(toolCallDelta, assistant.toolCalls);
        }
      } catch {
        // Ignore metadata or malformed SSE chunks while preserving the client stream.
      }
    }
  }

  private accumulateToolCall(
    delta: StreamToolCallDelta,
    toolCalls: Map<number, OpenAIToolCall>,
  ): void {
    const index = typeof delta.index === 'number' ? delta.index : 0;
    const current = toolCalls.get(index) ?? {
      id: '',
      type: 'function' as const,
      function: { name: '', arguments: '' },
    };
    if (isString(delta.id)) {
      current.id = delta.id;
    }
    if (isString(delta.function?.name)) {
      current.function.name += delta.function.name;
    }
    if (isString(delta.function?.arguments)) {
      current.function.arguments += delta.function.arguments;
    }
    toolCalls.set(index, current);
  }

  private extractBootstrapMessages(request: OpenAIChatRequest): OpenAIMessage[] {
    const extra = this.toRecord(request.extra);
    const bootstrapMessages = this.asMessageArray(extra?.session_bootstrap_messages);
    const bootstrapText = this.firstString([
      extra?.session_bootstrap,
      extra?.session_bootstrap_context,
    ]);
    if (!bootstrapText) {
      return bootstrapMessages;
    }
    return [...bootstrapMessages, { role: 'system', content: bootstrapText }];
  }

  private extractSessionId(request: OpenAIChatRequest): string | undefined {
    const extra = this.toRecord(request.extra);
    return this.firstString([request.session_id, extra?.session_id, extra?.sessionId]);
  }

  private shouldResetSession(request: OpenAIChatRequest): boolean {
    const extra = this.toRecord(request.extra);
    return request.session_reset === true || extra?.session_reset === true;
  }

  private isStoreDisabled(request: OpenAIChatRequest): boolean {
    const extra = this.toRecord(request.extra);
    return request.session_store === false || extra?.session_store === false;
  }

  private cleanSessionControls(value: unknown, sessionId: string): Record<string, unknown> {
    const cleaned = { ...(this.toRecord(value) ?? {}) };
    for (const key of [
      'session_bootstrap_messages',
      'session_bootstrap',
      'session_bootstrap_context',
      'session_reset',
      'session_store',
    ]) {
      delete cleaned[key];
    }
    cleaned.session_id = sessionId;
    return cleaned;
  }

  private trimMessages(messages: OpenAIMessage[]): OpenAIMessage[] {
    const systemMessages = messages.filter((message) => message.role === 'system');
    const nonSystemMessages = messages.filter((message) => message.role !== 'system');
    const keptSystem: OpenAIMessage[] = [];
    let usedChars = 0;

    for (const message of systemMessages) {
      const size = this.measureMessage(message);
      if (usedChars + size <= this.maxHistoryChars) {
        keptSystem.push(message);
        usedChars += size;
      }
    }

    const keptNonSystem: OpenAIMessage[] = [];
    for (let index = nonSystemMessages.length - 1; index >= 0; index -= 1) {
      const message = nonSystemMessages[index];
      const size = this.measureMessage(message);
      if (usedChars + size > this.maxHistoryChars) {
        continue;
      }
      keptNonSystem.unshift(message);
      usedChars += size;
    }
    return [...keptSystem, ...keptNonSystem];
  }

  private getOrCreateSession(sessionId: string): SessionState {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }
    const created = { messages: [], lastAccessedAt: Date.now() };
    this.sessions.set(sessionId, created);
    return created;
  }

  private pruneExpiredSessions(): void {
    const expiresBefore = Date.now() - this.sessionTtlMs;
    for (const [sessionId, state] of this.sessions) {
      if (state.lastAccessedAt < expiresBefore) {
        this.sessions.delete(sessionId);
      }
    }
  }

  private enforceMaxSessions(): void {
    while (this.sessions.size > this.maxSessions) {
      const oldest = [...this.sessions.entries()].sort(
        ([, left], [, right]) => left.lastAccessedAt - right.lastAccessedAt,
      )[0];
      if (!oldest) {
        return;
      }
      this.sessions.delete(oldest[0]);
    }
  }

  private asMessageArray(value: unknown): OpenAIMessage[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((item): item is OpenAIMessage => {
      if (!isPlainObject(item)) {
        return false;
      }
      const message = item as { role?: unknown; content?: unknown };
      return (
        isString(message.role) && (isString(message.content) || Array.isArray(message.content))
      );
    });
  }

  private firstString(values: unknown[]): string | undefined {
    const value = values.find((candidate) => isString(candidate) && !isEmpty(candidate.trim()));
    return isString(value) ? value.trim() : undefined;
  }

  private toRecord(value: unknown): Record<string, unknown> | undefined {
    return isPlainObject(value) ? (value as Record<string, unknown>) : undefined;
  }

  private cloneMessages(messages: OpenAIMessage[]): OpenAIMessage[] {
    return structuredClone(messages);
  }

  private cloneToolCalls(toolCalls: OpenAIToolCall[] | undefined): OpenAIToolCall[] | undefined {
    return toolCalls ? structuredClone(toolCalls) : undefined;
  }

  private measureMessage(message: OpenAIMessage): number {
    return this.fingerprint(message).length;
  }

  private fingerprint(message: OpenAIMessage): string {
    return JSON.stringify(message);
  }
}
