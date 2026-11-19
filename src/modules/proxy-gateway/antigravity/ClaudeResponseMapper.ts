import {
  decodeAntigravityGenerationResult,
  type AntigravityGenerationResult,
  type AntigravityResponseDecodeOptions,
} from './AntigravityResponseDecoder';
import { toAnthropicMessageId } from './anthropic-message-id';
import { toClaudeClientThoughtSignature } from './thought-signature-format';
import type { ClaudeResponse, GeminiResponse } from './types';

const stopReasons = {
  completed: 'end_turn',
  tool_call: 'tool_use',
  output_limit: 'max_tokens',
  blocked: 'content_filter',
} satisfies Record<AntigravityGenerationResult['finishReason'], string>;

export function transformResponse(
  geminiResponse: GeminiResponse,
  options?: AntigravityResponseDecodeOptions,
): ClaudeResponse {
  const result = decodeAntigravityGenerationResult(geminiResponse, options);
  return {
    id: toAnthropicMessageId(result.upstreamResponseId),
    type: 'message',
    role: 'assistant',
    model: result.model,
    content: result.content.map((block) => {
      if ((block.type === 'thinking' || block.type === 'tool_use') && block.signature) {
        return { ...block, signature: toClaudeClientThoughtSignature(block.signature) };
      }
      return block;
    }),
    stop_reason: stopReasons[result.finishReason],
    usage: {
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: result.usage.cachedInputTokens,
      reasoning_tokens: result.usage.reasoningTokens,
    },
    refusal: result.refusal,
  };
}
