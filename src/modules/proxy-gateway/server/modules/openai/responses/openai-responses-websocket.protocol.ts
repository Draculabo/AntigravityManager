import { randomUUID } from 'node:crypto';
import { awaitRequestOperation, throwIfRequestAborted } from '../../../common/request-cancellation';

import { mergeOpenAIResponsesInputItems } from './openai-responses-session.store';
import { parseResponsesInputItem } from './responses-input-item';
import { rememberResponsesToolCall } from './responses-tool-call-repair';

export type OpenAIResponsesWebSocketEvent = Record<string, unknown> & {
  type: string;
};

export type OpenAIResponsesWebSocketAction =
  | {
      events: OpenAIResponsesWebSocketEvent[];
      kind: 'local';
    }
  | {
      kind: 'request';
      request: Record<string, unknown>;
    };

/**
 * Stateful Responses WebSocket protocol adapter.
 *
 * The state transitions intentionally mirror the proven Codex transport:
 * prewarm locally, retain the previous request/output, merge append events,
 * repair compacted tool transcripts, and inherit stable request fields.
 */
export class OpenAIResponsesWebSocketProtocol {
  constructor(
    private readonly validateRequest?: (
      request: Record<string, unknown>,
      mode: 'prewarm' | 'generate',
    ) => void | Promise<void>,
  ) {}
  private lastRequest: Record<string, unknown> | null = null;
  private lastResponseOutput: unknown[] = [];
  private lastResponseId = '';
  private lastResponsePendingToolCallIds = new Set<string>();
  private readonly toolCallItems = new Map<string, unknown>();

  public async accept(
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<OpenAIResponsesWebSocketAction> {
    throwIfRequestAborted(signal);
    const event = toRecord(payload);
    if (!event) {
      throw new Error('websocket request must be a JSON object');
    }

    if (this.shouldHandlePrewarmLocally(event)) {
      return {
        events: await this.handlePrewarmLocally(event, signal),
        kind: 'local',
      };
    }

    return {
      kind: 'request',
      request: await this.normalizeRequest(event, signal),
    };
  }

  public complete(response: unknown): void {
    const responseRecord = toRecord(response);
    if (!responseRecord) {
      return;
    }

    const responseId = getString(responseRecord, 'id');
    const output = Array.isArray(responseRecord.output) ? responseRecord.output : [];
    this.lastResponseOutput = output;
    this.lastResponseId = responseId ?? '';
    this.lastResponsePendingToolCallIds.clear();

    for (const item of output) {
      const itemRecord = toRecord(item);
      const type = itemRecord ? getString(itemRecord, 'type') : null;
      if (type !== 'function_call' && type !== 'custom_tool_call') {
        continue;
      }
      const callId = getString(itemRecord, 'call_id') ?? getString(itemRecord, 'id');
      if (!callId) {
        continue;
      }
      rememberResponsesToolCall(this.toolCallItems, item);
      this.lastResponsePendingToolCallIds.add(callId);
    }
  }

  public getPreviousResponseId(): string {
    return this.lastResponseId;
  }

  public hasHistory(): boolean {
    return this.lastRequest !== null;
  }

  /** Release history even if a late operation or transport still references this closed context. */
  public dispose(): void {
    this.lastRequest = null;
    this.lastResponseOutput = [];
    this.lastResponseId = '';
    this.lastResponsePendingToolCallIds.clear();
    this.toolCallItems.clear();
  }

  private shouldHandlePrewarmLocally(payload: Record<string, unknown>): boolean {
    return (
      this.lastRequest === null &&
      getString(payload, 'type') === 'response.create' &&
      payload.generate === false
    );
  }

  private async handlePrewarmLocally(
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<OpenAIResponsesWebSocketEvent[]> {
    const responseId = `resp_prewarm_${randomUUID()}`;
    const createdAt = Math.floor(Date.now() / 1000);
    const model = getString(payload, 'model') ?? 'unknown';

    const created: OpenAIResponsesWebSocketEvent = {
      type: 'response.created',
      sequence_number: 0,
      response: {
        id: responseId,
        object: 'response',
        created_at: createdAt,
        status: 'in_progress',
        background: false,
        error: null,
        output: [],
        model,
      },
    };
    const completed: OpenAIResponsesWebSocketEvent = {
      type: 'response.completed',
      sequence_number: 1,
      response: {
        id: responseId,
        object: 'response',
        created_at: createdAt,
        status: 'completed',
        background: false,
        error: null,
        output: [],
        usage: {
          input_tokens: 0,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 0,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 0,
        },
        model,
      },
    };

    const normalized = { ...payload };
    delete normalized.type;
    delete normalized.generate;
    await this.validateBeforePublish(normalized, 'prewarm', signal);
    this.lastRequest = normalized;
    this.lastResponseOutput = [];
    this.lastResponseId = responseId;
    this.lastResponsePendingToolCallIds.clear();
    return [created, completed];
  }

  private async normalizeRequest(
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const eventType = getString(payload, 'type') ?? '';
    if (eventType === 'response.create' && this.lastRequest === null) {
      const normalized = { ...payload };
      delete normalized.type;
      delete normalized.generate;
      normalized.stream = true;
      normalized.input ??= [];
      if (!getString(normalized, 'model') && !getString(normalized, 'previous_response_id')) {
        throw new Error('missing model in response.create request');
      }
      await this.validateBeforePublish(normalized, 'generate', signal);
      this.lastRequest = normalized;
      return normalized;
    }

    if (eventType !== 'response.create' && eventType !== 'response.append') {
      throw new Error(`unsupported websocket request type: ${eventType}`);
    }
    if (this.lastRequest === null) {
      throw new Error('websocket request received before response.create');
    }

    if (shouldReplaceTranscript(payload)) {
      const replacement = { ...payload };
      delete replacement.type;
      delete replacement.generate;
      delete replacement.previous_response_id;
      replacement.stream = true;
      await this.validateBeforePublish(replacement, 'generate', signal);
      this.lastRequest = replacement;
      this.lastResponseOutput = [];
      return replacement;
    }

    const newInput = Array.isArray(payload.input) ? payload.input : [];

    const previousInput = Array.isArray(this.lastRequest.input) ? this.lastRequest.input : [];
    const mergedInput = mergeOpenAIResponsesInputItems(
      [...previousInput, ...this.lastResponseOutput],
      newInput,
      this.toolCallItems,
    );
    const normalized: Record<string, unknown> = {
      ...payload,
      input: mergedInput,
      stream: true,
    };
    delete normalized.type;
    delete normalized.generate;
    delete normalized.previous_response_id;

    for (const field of ['model', 'instructions', 'tools', 'tool_choice']) {
      if (!(field in normalized) && field in this.lastRequest) {
        normalized[field] = this.lastRequest[field];
      }
    }

    await this.validateBeforePublish(normalized, 'generate', signal);
    for (const item of newInput) {
      const itemRecord = toRecord(item);
      const type = itemRecord ? getString(itemRecord, 'type') : null;
      if (type !== 'function_call_output' && type !== 'custom_tool_call_output') {
        continue;
      }
      const callId = getString(itemRecord, 'call_id');
      if (callId) {
        this.lastResponsePendingToolCallIds.delete(callId);
      }
    }
    this.lastRequest = normalized;
    // Completion output has been merged or explicitly compacted out. Reusing it after a
    // failed generation would reintroduce discarded text or duplicate ID-less items.
    this.lastResponseOutput = [];
    return normalized;
  }

  private async validateBeforePublish(
    request: Record<string, unknown>,
    mode: 'prewarm' | 'generate',
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfRequestAborted(signal);
    await awaitRequestOperation(Promise.resolve(this.validateRequest?.(request, mode)), signal);
    throwIfRequestAborted(signal);
  }
}

function shouldReplaceTranscript(payload: Record<string, unknown>): boolean {
  if (getString(payload, 'previous_response_id')) {
    return false;
  }
  if (!Array.isArray(payload.input)) {
    return false;
  }

  return payload.input.some((item) => {
    const parsed = parseResponsesInputItem(item);
    if (!parsed) {
      return false;
    }
    if (parsed.type === 'function_call' || parsed.type === 'custom_tool_call') {
      return true;
    }
    return parsed.type === 'message' && parsed.role === 'assistant';
  });
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getString(record: Record<string, unknown> | null, field: string): string | null {
  const value = record?.[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
