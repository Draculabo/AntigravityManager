import {
  rebindModelVariant,
  resolveModelVariant,
  usesAuthoritativeThinkingBudget,
} from '../../../antigravity/model-variant-registry';
import type {
  AnthropicChatRequest,
  GeminiRequest,
  OpenAIChatRequest,
} from '../../common/interfaces/request-interfaces';

function removeAuthoritativeGeminiThinkingControls(request: GeminiRequest): GeminiRequest {
  const generationConfig = request.generationConfig;
  if (!generationConfig?.thinkingConfig) {
    return request;
  }

  const { thinkingConfig: _thinkingConfig, ...sanitizedGenerationConfig } = generationConfig;
  const { generationConfig: _generationConfig, ...requestWithoutGenerationConfig } = request;
  if (Object.keys(sanitizedGenerationConfig).length === 0) {
    return requestWithoutGenerationConfig;
  }

  return {
    ...requestWithoutGenerationConfig,
    generationConfig: sanitizedGenerationConfig,
  };
}

function removeAuthoritativeOpenAIThinkingControls(request: OpenAIChatRequest): OpenAIChatRequest {
  if (!request.thinking) {
    return request;
  }

  const { budget_tokens: _budgetTokens, effort: _effort, ...thinking } = request.thinking;
  return {
    ...request,
    thinking,
  };
}

function removeAuthoritativeAnthropicThinkingControls(
  request: AnthropicChatRequest,
): AnthropicChatRequest {
  if (!request.thinking) {
    return request;
  }

  const { budget_tokens: _budgetTokens, ...thinking } = request.thinking;
  return {
    ...request,
    thinking,
  };
}

export interface AppliedGeminiModelVariant {
  model: string;
  request: GeminiRequest;
  variant: ReturnType<typeof resolveModelVariant>;
}

export function applyGeminiModelVariant(
  model: string,
  request: GeminiRequest,
): AppliedGeminiModelVariant {
  const usesAuthoritativeBudget = usesAuthoritativeThinkingBudget(model);
  const sanitizedRequest = usesAuthoritativeBudget
    ? removeAuthoritativeGeminiThinkingControls(request)
    : request;
  const thinkingConfig = sanitizedRequest.generationConfig?.thinkingConfig;
  const variant = resolveModelVariant({
    model,
    budgetTokens: thinkingConfig?.thinkingBudget,
    effort: thinkingConfig?.thinkingLevel,
  });

  return {
    model: variant?.model ?? model,
    request: sanitizedRequest,
    variant,
  };
}

export function rebindGeminiModelVariant(
  applied: AppliedGeminiModelVariant,
  physicalModel: string,
): AppliedGeminiModelVariant {
  const variant = rebindModelVariant(applied.variant, physicalModel);

  return {
    model: variant?.model ?? physicalModel,
    request: applied.request,
    variant,
  };
}

export interface AppliedAnthropicModelVariant {
  request: AnthropicChatRequest;
  variant: ReturnType<typeof resolveModelVariant>;
}

export function applyAnthropicModelVariant(
  request: AnthropicChatRequest,
): AppliedAnthropicModelVariant {
  const usesAuthoritativeBudget = usesAuthoritativeThinkingBudget(request.model);
  const sanitizedRequest = usesAuthoritativeBudget
    ? removeAuthoritativeAnthropicThinkingControls(request)
    : request;
  const variant = resolveModelVariant({
    model: sanitizedRequest.model,
    budgetTokens: sanitizedRequest.thinking?.budget_tokens,
    effort: sanitizedRequest.output_config?.effort,
  });
  if (!variant) {
    return {
      request: sanitizedRequest,
      variant: null,
    };
  }

  return {
    request: {
      ...sanitizedRequest,
      model: variant.model,
      max_tokens: variant.maxOutputTokens,
      thinking:
        variant.thinkingBudget === 0
          ? undefined
          : {
              type: 'enabled',
              budget_tokens: variant.thinkingBudget,
            },
      tools: variant.supportsTools ? sanitizedRequest.tools : undefined,
      tool_choice: variant.supportsTools ? sanitizedRequest.tool_choice : undefined,
      output_config: undefined,
    },
    variant,
  };
}

export function rebindAnthropicModelVariant(
  applied: AppliedAnthropicModelVariant,
  physicalModel: string,
): AppliedAnthropicModelVariant {
  const variant = rebindModelVariant(applied.variant, physicalModel);
  if (!variant) {
    return applied;
  }

  return {
    request: {
      ...applied.request,
      model: variant.model,
      max_tokens: variant.maxOutputTokens,
      thinking:
        variant.thinkingBudget === 0
          ? undefined
          : {
              type: 'enabled',
              budget_tokens: variant.thinkingBudget,
            },
      tools: variant.supportsTools ? applied.request.tools : undefined,
      tool_choice: variant.supportsTools ? applied.request.tool_choice : undefined,
    },
    variant,
  };
}

export interface AppliedOpenAIModelVariant {
  request: OpenAIChatRequest;
  variant: ReturnType<typeof resolveModelVariant>;
}

export function applyOpenAIModelVariant(request: OpenAIChatRequest): AppliedOpenAIModelVariant {
  const usesAuthoritativeBudget = usesAuthoritativeThinkingBudget(request.model);
  const sanitizedRequest = usesAuthoritativeBudget
    ? removeAuthoritativeOpenAIThinkingControls(request)
    : request;
  const variant = resolveModelVariant({
    model: sanitizedRequest.model,
    budgetTokens: sanitizedRequest.thinking?.budget_tokens,
    effort: sanitizedRequest.reasoning_effort ?? sanitizedRequest.thinking?.effort,
  });
  if (!variant) {
    return {
      request: sanitizedRequest,
      variant: null,
    };
  }

  return {
    request: {
      ...sanitizedRequest,
      model: variant.model,
      max_tokens: variant.maxOutputTokens,
      thinking:
        variant.thinkingBudget === 0
          ? undefined
          : {
              type: 'enabled',
              budget_tokens: variant.thinkingBudget,
            },
      tools: variant.supportsTools ? request.tools : undefined,
      tool_choice: variant.supportsTools ? request.tool_choice : undefined,
      ...(sanitizedRequest.reasoning_effort !== undefined
        ? { reasoning_effort: variant.tier }
        : {}),
    },
    variant,
  };
}

export function rebindOpenAIModelVariant(
  applied: AppliedOpenAIModelVariant,
  physicalModel: string,
): AppliedOpenAIModelVariant {
  const variant = rebindModelVariant(applied.variant, physicalModel);
  if (!variant) {
    return applied;
  }

  return {
    request: {
      ...applied.request,
      model: variant.model,
      max_tokens: variant.maxOutputTokens,
      thinking:
        variant.thinkingBudget === 0
          ? undefined
          : {
              type: 'enabled',
              budget_tokens: variant.thinkingBudget,
            },
      tools: variant.supportsTools ? applied.request.tools : undefined,
      tool_choice: variant.supportsTools ? applied.request.tool_choice : undefined,
      ...(applied.request.reasoning_effort !== undefined ? { reasoning_effort: variant.tier } : {}),
    },
    variant,
  };
}
