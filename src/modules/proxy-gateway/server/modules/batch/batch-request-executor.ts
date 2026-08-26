import { Observable } from 'rxjs';

import type {
  AnthropicChatRequest,
  AnthropicChatResponse,
  GeminiRequest,
  GeminiResponse,
  OpenAIChatRequest,
  OpenAIChatResponse,
} from '../../common/interfaces/request-interfaces';
import {
  BatchJobError,
  SERVABLE_BATCH_ENDPOINTS,
  type BatchJobRecord,
  type BatchRequestError,
  type BatchRequestRecord,
} from './batch-job.types';

/**
 * The slice of protocol-service behaviour a batch needs to run one request.
 *
 * The gateway binds the existing protocol handlers during bootstrap. Batch
 * execution therefore follows the same account-selection, routing, retry, and
 * rate-limit path as interactive requests.
 */
export interface BatchExecutionTarget {
  handleChatCompletions(
    request: OpenAIChatRequest,
  ): Promise<OpenAIChatResponse | Observable<string>>;
  handleAnthropicMessages(
    request: AnthropicChatRequest,
  ): Promise<AnthropicChatResponse | Observable<string>>;
  handleGeminiGenerateContent(model: string, request: GeminiRequest): Promise<GeminiResponse>;
}

export type BatchExecutionResult =
  | { outcome: 'succeeded'; response: unknown }
  | { outcome: 'errored'; error: BatchRequestError };

/**
 * Runs one request line to completion.
 *
 * Streaming is refused rather than silently dropped: a batch collects whole
 * results, so a stored body asking for `stream: true` has the flag stripped
 * before dispatch, and if a target still hands back an `Observable` (a
 * misbehaving fake, or a future target that forgets to honour the stripped
 * flag) that is treated as a request error rather than a half-honoured stream.
 */
export async function executeBatchRequest(
  job: BatchJobRecord,
  request: BatchRequestRecord,
  target: BatchExecutionTarget,
): Promise<BatchExecutionResult> {
  try {
    const response = await dispatch(job, request, target);
    if (response instanceof Observable) {
      throw new Error('Batch requests cannot be streamed; remove "stream" from the request body');
    }
    return { outcome: 'succeeded', response };
  } catch (error) {
    return { outcome: 'errored', error: toBatchRequestError(error) };
  }
}

async function dispatch(
  job: BatchJobRecord,
  request: BatchRequestRecord,
  target: BatchExecutionTarget,
): Promise<unknown> {
  if (job.dialect === 'gemini') {
    return target.handleGeminiGenerateContent(
      request.target ?? job.endpoint,
      request.body as GeminiRequest,
    );
  }

  if (job.dialect === 'anthropic') {
    return target.handleAnthropicMessages(withoutStream(request.body) as AnthropicChatRequest);
  }

  if (job.endpoint !== SERVABLE_BATCH_ENDPOINTS[0]) {
    throw BatchJobError.unservableEndpoint(job.endpoint, SERVABLE_BATCH_ENDPOINTS);
  }
  return target.handleChatCompletions(withoutStream(request.body) as OpenAIChatRequest);
}

/** Batches never stream; the flag is removed before the handler sees the body. */
function withoutStream(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return body;
  }
  const { stream: _stream, ...rest } = body as Record<string, unknown>;
  return rest;
}

/**
 * Normalizes anything a handler can throw into the record a result line keeps.
 * The HTTP status is preserved because each dialect's result shape reports it.
 */
export function toBatchRequestError(error: unknown): BatchRequestError {
  const status =
    readNumber(error, 'httpStatus') ?? readNumber(error, 'status') ?? readNumber(error, 'code');
  const httpStatus = status && status >= 400 && status <= 599 ? status : 500;
  const code = readString(error, 'code') ?? readString(error, 'type') ?? defaultCode(httpStatus);
  return {
    message: error instanceof Error ? error.message : 'Batch request failed',
    code,
    httpStatus,
  };
}

function defaultCode(httpStatus: number): string {
  if (httpStatus === 404) {
    return 'not_found_error';
  }
  if (httpStatus === 429) {
    return 'rate_limit_error';
  }
  return httpStatus >= 500 ? 'api_error' : 'invalid_request_error';
}

function readNumber(error: unknown, key: string): number | undefined {
  const value = (error as Record<string, unknown> | null)?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readString(error: unknown, key: string): string | undefined {
  const value = (error as Record<string, unknown> | null)?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}
