/**
 * Anthropic's deprecated Text Completions endpoint, `POST /v1/complete`.
 *
 * It maps cleanly onto the Messages path this proxy already serves: the
 * `\n\nHuman: ... \n\nAssistant:` prompt form is a conversation written as one
 * string, so it is parsed back into turns, `max_tokens_to_sample` becomes
 * `max_tokens`, and the Messages response is rendered back as
 * `{completion, stop_reason, model}`.
 *
 * Nothing here reaches upstream differently from a Messages request. The
 * endpoint exists so a client still speaking the old dialect is not left with
 * a bare 404; it is deprecated at Anthropic too.
 */

import type {
  AnthropicChatRequest,
  AnthropicChatResponse,
} from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';

import {
  anthropicFileErrorResponse,
  type AnthropicErrorEnvelope,
} from '../files/anthropic-file-resource';

const HUMAN_TURN = '\n\nHuman:';
const ASSISTANT_TURN = '\n\nAssistant:';

export class AnthropicCompleteValidationError extends Error {
  public readonly httpStatus = 400;

  constructor(message: string) {
    super(message);
    this.name = 'AnthropicCompleteValidationError';
  }
}

export interface AnthropicCompleteRequest {
  model: string;
  prompt: string;
  max_tokens_to_sample: number;
  stop_sequences?: string[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  metadata?: Record<string, unknown>;
  stream?: boolean;
}

export function normalizeAnthropicCompleteRequest(body: unknown): AnthropicCompleteRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AnthropicCompleteValidationError('body must be a JSON object');
  }
  const raw = body as Record<string, unknown>;
  const model = raw.model;
  if (typeof model !== 'string' || !model.trim()) {
    throw new AnthropicCompleteValidationError('model is required');
  }
  const prompt = raw.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new AnthropicCompleteValidationError('prompt is required');
  }
  const maxTokens = raw.max_tokens_to_sample;
  if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new AnthropicCompleteValidationError('max_tokens_to_sample must be a positive integer');
  }
  const stopSequences = raw.stop_sequences;
  if (stopSequences !== undefined && !isStringArray(stopSequences)) {
    throw new AnthropicCompleteValidationError('stop_sequences must be an array of strings');
  }

  return {
    model: model.trim(),
    prompt,
    max_tokens_to_sample: maxTokens,
    ...(stopSequences ? { stop_sequences: stopSequences } : {}),
    ...(typeof raw.temperature === 'number' ? { temperature: raw.temperature } : {}),
    ...(typeof raw.top_p === 'number' ? { top_p: raw.top_p } : {}),
    ...(typeof raw.top_k === 'number' ? { top_k: raw.top_k } : {}),
    ...(isRecord(raw.metadata) ? { metadata: raw.metadata } : {}),
    ...(typeof raw.stream === 'boolean' ? { stream: raw.stream } : {}),
  };
}

/**
 * Splits the prompt back into turns.
 *
 * A prompt that never uses the `\n\nHuman:` marker is treated as a single
 * user turn rather than rejected, because that is what the old API accepted
 * in practice. The trailing `\n\nAssistant:` is the request for output and
 * carries no content unless the caller prefilled it, in which case the
 * prefill is kept as an assistant turn -- that is exactly what it meant on the
 * old endpoint.
 */
export function splitCompletionPrompt(
  prompt: string,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!prompt.includes(HUMAN_TURN.trimStart()) && !prompt.includes(ASSISTANT_TURN.trimStart())) {
    return [{ role: 'user', content: prompt.trim() }];
  }

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  const pattern = /\n{0,2}(Human|Assistant):/gu;
  let match: RegExpExecArray | null = pattern.exec(prompt);
  while (match !== null) {
    const role = match[1] === 'Human' ? 'user' : 'assistant';
    const start = match.index + match[0].length;
    const next: RegExpExecArray | null = pattern.exec(prompt);
    const content = prompt.slice(start, next?.index ?? prompt.length).trim();
    if (content) {
      messages.push({ role, content });
    }
    match = next;
  }

  if (messages.length === 0) {
    return [{ role: 'user', content: prompt.trim() }];
  }
  return messages;
}

/**
 * Renders the completion request as the `AnthropicChatRequest` the Messages
 * path expects.
 */
export function toAnthropicMessagesRequest(
  request: AnthropicCompleteRequest,
): AnthropicChatRequest {
  const messages = splitCompletionPrompt(request.prompt);
  return {
    model: request.model,
    max_tokens: request.max_tokens_to_sample,
    messages,
    ...(request.stop_sequences ? { stop_sequences: request.stop_sequences } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.top_p !== undefined ? { top_p: request.top_p } : {}),
    ...(request.top_k !== undefined ? { top_k: request.top_k } : {}),
    ...(request.metadata ? { metadata: request.metadata } : {}),
  };
}

export interface AnthropicCompletionResponse {
  type: 'completion';
  id: string;
  completion: string;
  stop_reason: string | null;
  stop: string | null;
  model: string;
}

export function toAnthropicCompletionResponse(
  message: AnthropicChatResponse,
  fallbackModel: string,
  id: string,
): AnthropicCompletionResponse {
  const content = Array.isArray(message.content) ? message.content : [];
  const completion = content.map((block) => (block.type === 'text' ? block.text : '')).join('');
  return {
    type: 'completion',
    id,
    // The old API's `completion` always began with a leading space after
    // `Assistant:`; the Messages content does not, so it is added back.
    completion: completion ? ` ${completion.replace(/^\s+/u, '')}` : '',
    stop_reason: typeof message.stop_reason === 'string' ? message.stop_reason : null,
    stop: typeof message.stop_sequence === 'string' ? message.stop_sequence : null,
    model: typeof message.model === 'string' ? message.model : fallbackModel,
  };
}

/**
 * The Anthropic error envelope, reusing the files surface's builder.
 *
 * The request contracts carry their HTTP status as `httpStatus` already,
 * which is exactly what {@link anthropicFileErrorResponse} reads, so no
 * status-field translation is needed here.
 */
export function anthropicCompleteErrorResponse(
  error: unknown,
  requestId: string,
): { statusCode: number; body: AnthropicErrorEnvelope } {
  return anthropicFileErrorResponse(error, requestId);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
