import type { AntigravityTokenUsage } from './AntigravityResponseDecoder';
import type { OpenAIUsage } from '../../../server/gateway/common/interfaces/request-interfaces';

export interface OpenAIResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: {
    cached_tokens?: number;
  };
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
}

/**
 * Preserves the upstream total when the decoded response provides one.
 */
export function toOpenAIUsage(usage: AntigravityTokenUsage | undefined): OpenAIUsage {
  const promptTokens = usage?.inputTokens ?? 0;
  const completionTokens = usage?.outputTokens ?? 0;
  const cachedTokens = usage?.cachedInputTokens ?? 0;
  const reasoningTokens = usage?.reasoningTokens ?? 0;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage?.totalTokens ?? promptTokens + completionTokens,
    prompt_tokens_details: cachedTokens > 0 ? { cached_tokens: cachedTokens } : undefined,
    completion_tokens_details:
      reasoningTokens > 0 ? { reasoning_tokens: reasoningTokens } : undefined,
  };
}

/**
 * The Responses API uses input/output field names, while Chat Completions uses
 * prompt/completion. Keep the token values and supplemental details identical.
 */
export function toOpenAIResponsesUsage(usage: OpenAIUsage): OpenAIResponsesUsage {
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    input_tokens_details: usage.prompt_tokens_details,
    output_tokens_details: usage.completion_tokens_details,
  };
}
