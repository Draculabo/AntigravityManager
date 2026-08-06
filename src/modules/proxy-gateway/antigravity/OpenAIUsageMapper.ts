import type { Usage } from './types';
import type { GeminiUsageMetadata, OpenAIUsage } from '../server/common/interfaces/request-interfaces';

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
 * Maps Gemini-compatible usage to OpenAI usage without changing the upstream
 * totals. Cached and reasoning counts are supplemental details for billing UI.
 */
export function toOpenAIUsage(usage: Usage | undefined): OpenAIUsage {
  const promptTokens = usage?.input_tokens ?? 0;
  const completionTokens = usage?.output_tokens ?? 0;
  const cachedTokens = usage?.cache_read_input_tokens ?? 0;
  const reasoningTokens = usage?.reasoning_tokens ?? 0;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: cachedTokens > 0 ? { cached_tokens: cachedTokens } : undefined,
    completion_tokens_details:
      reasoningTokens > 0 ? { reasoning_tokens: reasoningTokens } : undefined,
  };
}

/**
 * Converts the upstream Gemini usage shape before applying the shared OpenAI
 * normalization, so streamed and non-streamed responses report the same fields.
 */
export function toOpenAIUsageFromGeminiUsageMetadata(
  usage: GeminiUsageMetadata | undefined,
): OpenAIUsage {
  const reasoningTokens =
    usage?.total_thought_tokens ?? usage?.totalThoughtTokens ?? usage?.thoughtsTokenCount ?? 0;
  const toolUseTokens = usage?.total_tool_use_tokens ?? 0;
  /**
   * Gemini's legacy candidatesTokenCount already includes thought/tool-use
   * tokens. The Interactions-style total_output_tokens field reports generated
   * output separately, so only that format needs the supplemental counts.
   */
  const outputTokens =
    usage?.total_output_tokens === undefined
      ? (usage?.candidatesTokenCount ?? 0)
      : usage.total_output_tokens + reasoningTokens + toolUseTokens;

  const normalizedUsage = toOpenAIUsage(
    usage
      ? {
          input_tokens: usage.total_input_tokens ?? usage.promptTokenCount ?? 0,
          output_tokens: outputTokens,
          cache_read_input_tokens:
            usage.total_cached_tokens ?? usage.cachedContentTokenCount ?? usage.cachedTokens ?? 0,
          reasoning_tokens: reasoningTokens,
        }
      : undefined,
  );
  const upstreamTotalTokens = usage?.total_tokens ?? usage?.totalTokenCount;

  return upstreamTotalTokens === undefined
    ? normalizedUsage
    : { ...normalizedUsage, total_tokens: upstreamTotalTokens };
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
