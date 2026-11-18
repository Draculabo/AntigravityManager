import { SchemaInputError } from '../../../modules/proxy-gateway/antigravity/schema/SchemaConversion';
import { InvalidToolResultAssociationError } from '../../../modules/proxy-gateway/antigravity/ClaudeToolResultAssociation';
import { ToolConfigurationError } from '../../../modules/proxy-gateway/antigravity/ToolChoiceCompat';
import { OutputTokenLimitConflictError } from './output-token-limit';
import { InvalidModelEffortError } from './invalid-model-effort.error';
import { UpstreamGenerationError } from '../../../modules/proxy-gateway/antigravity/UpstreamGenerationError';
import { UpstreamRequestError } from './exceptions/upstream-request.exception';
import { GenerationReplayLimitError } from './exceptions/generation-replay-limit.exception';
import { RetiredModelError } from './exceptions/retired-model.exception';

type OpenAIErrorFields = {
  type: 'invalid_request_error' | 'rate_limit_error' | 'server_error';
  code?: string;
  param?: string | null;
};

/** Gateway-owned metadata only; provider bodies are not an OpenAI field contract. */
export function openAIHttpErrorFields(status: number, error: unknown): OpenAIErrorFields {
  const type =
    status === 429 ? 'rate_limit_error' : status < 500 ? 'invalid_request_error' : 'server_error';
  if (error instanceof RetiredModelError) {
    return { type, code: 'model_not_found', param: 'model' };
  }
  if (error instanceof UpstreamGenerationError || error instanceof GenerationReplayLimitError) {
    return { type, code: error.code, param: null };
  }
  if (error instanceof UpstreamRequestError && error.upstreamStatus) {
    return { type, code: error.upstreamStatus, param: null };
  }
  if (error instanceof SchemaInputError) {
    return { type, code: 'invalid_request_schema', param: null };
  }
  if (error instanceof InvalidToolResultAssociationError) {
    return { type, code: 'invalid_tool_history', param: null };
  }
  if (error instanceof ToolConfigurationError) {
    return { type, code: 'invalid_tool_choice', param: 'tool_choice' };
  }
  if (error instanceof OutputTokenLimitConflictError) {
    return { type, code: 'conflicting_output_token_limits', param: null };
  }
  if (error instanceof InvalidModelEffortError) {
    // Effort can originate in model aliases or different request fields, so do not guess a path.
    return { type, code: 'invalid_model_effort', param: null };
  }
  return { type };
}

/** Classify the public HTTP status after protocol-specific compatibility projection. */
export function anthropicHttpErrorType(status: number): string {
  switch (status) {
    case 401:
      return 'authentication_error';
    case 402:
      return 'billing_error';
    case 403:
      return 'permission_error';
    case 404:
      return 'not_found_error';
    case 409:
      return 'conflict_error';
    case 413:
      return 'request_too_large';
    case 429:
      return 'rate_limit_error';
    case 504:
      return 'timeout_error';
    case 529:
      return 'overloaded_error';
    default:
      return status < 500 ? 'invalid_request_error' : 'api_error';
  }
}
