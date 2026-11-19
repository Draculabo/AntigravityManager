import { isString } from 'lodash-es';
import {
  buildAntigravityGenerationRequest,
  type AntigravityRequestOptions,
} from './AntigravityRequestBuilder';
import { resolveGenerationOutput, type GenerationParameters } from './generation-input';
import type { ClaudeRequest } from './types';

const ANTHROPIC_STOP_SEQUENCES = [
  '<|user|>',
  '<|endoftext|>',
  '<|end_of_turn|>',
  '[DONE]',
  '\n\nHuman:',
];

export function transformClaudeRequestIn(
  request: ClaudeRequest,
  projectId?: string,
  userAgent?: string,
  resolvedModel?: string,
  options?: Omit<AntigravityRequestOptions, 'projectId' | 'userAgent' | 'resolvedModel'>,
) {
  const { thinking, metadata } = request;
  const signatureSessionKey = metadata?.signature_session_key;
  // Existing Anthropic clients can send this metadata value to select OpenAI defaults.
  const useOpenAIDefaults = String(metadata?.source || '').toLowerCase() === 'openai';
  const parameters: GenerationParameters = useOpenAIDefaults
    ? {
        temperature: request.temperature ?? 1,
        topP: request.top_p ?? 0.95,
        presencePenalty: request.presence_penalty,
        frequencyPenalty: request.frequency_penalty,
        seed: request.seed,
        maxOutputTokens: request.max_tokens,
        stopSequences: request.stop_sequences?.length ? request.stop_sequences : undefined,
      }
    : {
        temperature: request.temperature,
        topP: request.top_p,
        topK: request.top_k,
        maxOutputTokens: request.max_tokens,
        stopSequences: [...ANTHROPIC_STOP_SEQUENCES],
      };

  return buildAntigravityGenerationRequest(
    {
      model: request.model,
      messages: request.messages,
      system: request.system,
      tools: request.tools,
      toolChoice: request.tool_choice,
      signatureSessionKey: isString(signatureSessionKey) ? signatureSessionKey : undefined,
      thinking: thinking && {
        type: thinking.type,
        budgetTokens: thinking.budget_tokens,
        effort: thinking.effort,
      },
      outputEffort: request.output_config?.effort,
      output: resolveGenerationOutput(request.response_format),
      parameters,
      thinkingAfterParameters: useOpenAIDefaults || undefined,
    },
    { ...options, projectId, userAgent, resolvedModel },
  );
}
