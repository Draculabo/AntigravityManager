import { randomUUID } from 'node:crypto';

import { mergeOpenAIResponsesInputItems } from './openai-responses-session.store';

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
  private lastRequest: Record<string, unknown> | null = null;
  private lastResponseOutput: unknown[] = [];
  private lastResponseId = '';
  private lastResponsePendingToolCallIds = new Set<string>();
  private readonly toolCallItems = new Map<string, unknown>();

  public accept(payload: unknown): OpenAIResponsesWebSocketAction {
    const event = toRecord(payload);
    if (!event) {
      throw new Error('websocket request must be a JSON object');
    }

    if (this.shouldHandlePrewarmLocally(event)) {
      return {
        events: this.handlePrewarmLocally(event),
        kind: 'local',
      };
    }

    return {
      kind: 'request',
      request: this.normalizeRequest(event),
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
      this.toolCallItems.set(callId, item);
      this.lastResponsePendingToolCallIds.add(callId);
    }
  }

  public getPreviousResponseId(): string {
    return this.lastResponseId;
  }

  private shouldHandlePrewarmLocally(payload: Record<string, unknown>): boolean {
    return (
      this.lastRequest === null &&
      getString(payload, 'type') === 'response.create' &&
      payload.generate === false
    );
  }

  private handlePrewarmLocally(payload: Record<string, unknown>): OpenAIResponsesWebSocketEvent[] {
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
    this.lastRequest = normalized;
    this.lastResponseOutput = [];
    this.lastResponseId = responseId;
    this.lastResponsePendingToolCallIds.clear();
    return [created, completed];
  }

  private normalizeRequest(payload: Record<string, unknown>): Record<string, unknown> {
    const eventType = getString(payload, 'type') ?? '';
    if (eventType === 'response.create' && this.lastRequest === null) {
      const normalized = { ...payload };
      delete normalized.type;
      delete normalized.generate;
      normalized.stream = true;
      normalized.input ??= [];
      if (!getString(normalized, 'model')) {
        throw new Error('missing model in response.create request');
      }
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
      this.lastRequest = replacement;
      return replacement;
    }

    const newInput = Array.isArray(payload.input) ? payload.input : [];
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

    const previousInput = Array.isArray(this.lastRequest.input) ? this.lastRequest.input : [];
    const mergedInput = mergeOpenAIResponsesInputItems(
      [...previousInput, ...this.lastResponseOutput],
      newInput,
      [...this.toolCallItems.values()],
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

    this.lastRequest = normalized;
    return normalized;
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
    const record = toRecord(item);
    const type = record ? getString(record, 'type') : null;
    if (type === 'function_call' || type === 'custom_tool_call') {
      return true;
    }
    return type === 'message' && getString(record, 'role') === 'assistant';
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
