import { getServerConfig } from '@/server/server-config';
import {
  rebindModelVariant,
  resolveModelVariant,
  usesAuthoritativeThinkingBudget,
} from '../../../../modules/proxy-gateway/antigravity/model-variant-registry';
import type {
  AnthropicChatRequest,
  GeminiRequest,
  OpenAIChatRequest,
} from '../../common/interfaces/request-interfaces';
import { assertSupportedModelEffort, isDisabledThinkingEffort } from '../../common/model-effort';

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
  if (!request.thinking && !request.reasoning) {
    return request;
  }

  const { budget_tokens: _budgetTokens, effort: _effort, ...thinking } = request.thinking ?? {};
  const { effort: _reasoningEffort, ...reasoning } = request.reasoning ?? {};
  return {
    ...request,
    thinking: request.thinking ? thinking : undefined,
    reasoning: request.reasoning
      ? Object.keys(reasoning).length > 0
        ? reasoning
        : undefined
      : undefined,
  };
}

function restoreOpenAIEffortAfterVariant(
  request: OpenAIChatRequest,
  source: OpenAIChatRequest,
): OpenAIChatRequest {
  if (source.reasoning?.effort !== undefined && request.reasoning?.effort === undefined) {
    return {
      ...request,
      reasoning: {
        ...request.reasoning,
        effort: source.reasoning.effort,
      },
    };
  }
  return request;
}

export function resolveOpenAIRoutingEffort(request: OpenAIChatRequest): string | undefined {
  const effort = request.reasoning_effort ?? request.reasoning?.effort ?? request.thinking?.effort;
  return isDisabledThinkingEffort(effort) ? undefined : effort;
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
  physicalTarget = false,
): AppliedGeminiModelVariant {
  const clientControlled = getServerConfig()?.thinking_budget?.control_source === 'client';
  const requestedEffort = request.generationConfig?.thinkingConfig?.thinkingLevel;
  const routeEffort =
    clientControlled && isDisabledThinkingEffort(requestedEffort) ? undefined : requestedEffort;
  assertSupportedModelEffort(routeEffort);
  const usesAuthoritativeBudget = !clientControlled && usesAuthoritativeThinkingBudget(model);
  const sanitizedRequest = usesAuthoritativeBudget
    ? removeAuthoritativeGeminiThinkingControls(request)
    : request;
  const thinkingConfig = sanitizedRequest.generationConfig?.thinkingConfig;
  const variant = resolveModelVariant({
    model,
    physicalTarget,
    budgetTokens: thinkingConfig?.thinkingBudget,
    effort: clientControlled ? routeEffort : thinkingConfig?.thinkingLevel,
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
  physicalTarget = false,
): AppliedAnthropicModelVariant {
  const clientControlled = getServerConfig()?.thinking_budget?.control_source === 'client';
  const requestedEffort = request.output_config?.effort;
  const routeEffort =
    clientControlled && isDisabledThinkingEffort(requestedEffort) ? undefined : requestedEffort;
  assertSupportedModelEffort(routeEffort);
  const usesAuthoritativeBudget =
    !clientControlled && usesAuthoritativeThinkingBudget(request.model);
  const sanitizedRequest = usesAuthoritativeBudget
    ? removeAuthoritativeAnthropicThinkingControls(request)
    : request;
  const variant = resolveModelVariant({
    model: sanitizedRequest.model,
    physicalTarget,
    budgetTokens: sanitizedRequest.thinking?.budget_tokens,
    effort: routeEffort,
  });
  if (!variant) {
    return {
      request: sanitizedRequest,
      variant: null,
    };
  }

  if (clientControlled) {
    return { request: { ...sanitizedRequest, model: variant.model }, variant };
  }

  return {
    request: {
      ...sanitizedRequest,
      model: variant.model,
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
    return { request: { ...applied.request, model: physicalModel }, variant: null };
  }

  if (getServerConfig()?.thinking_budget?.control_source === 'client') {
    return { request: { ...applied.request, model: variant.model }, variant };
  }

  return {
    request: {
      ...applied.request,
      model: variant.model,
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

export function applyOpenAIModelVariant(
  request: OpenAIChatRequest,
  physicalTarget = false,
): AppliedOpenAIModelVariant {
  const clientControlled = getServerConfig()?.thinking_budget?.control_source === 'client';
  const usesAuthoritativeBudget =
    !clientControlled && usesAuthoritativeThinkingBudget(request.model);
  const routeEffort = resolveOpenAIRoutingEffort(request);
  assertSupportedModelEffort(routeEffort);
  const variantEffort =
    request.reasoning_effort ??
    request.reasoning?.effort ??
    (usesAuthoritativeBudget ? undefined : request.thinking?.effort);
  const sanitizedRequest = usesAuthoritativeBudget
    ? removeAuthoritativeOpenAIThinkingControls(request)
    : request;
  const variant = resolveModelVariant({
    model: sanitizedRequest.model,
    physicalTarget,
    budgetTokens: sanitizedRequest.thinking?.budget_tokens,
    effort: clientControlled ? routeEffort : variantEffort,
  });
  if (!variant) {
    return {
      request: sanitizedRequest,
      variant: null,
    };
  }

  if (clientControlled) {
    return { request: { ...sanitizedRequest, model: variant.model }, variant };
  }

  return {
    request: {
      ...sanitizedRequest,
      model: variant.model,
      thinking:
        variant.thinkingBudget === 0
          ? undefined
          : usesAuthoritativeBudget
            ? {
                type: 'enabled',
                budget_tokens: variant.thinkingBudget,
              }
            : sanitizedRequest.thinking
              ? {
                  ...sanitizedRequest.thinking,
                  budget_tokens: variant.thinkingBudget,
                }
              : undefined,
      tools: variant.supportsTools ? request.tools : undefined,
      tool_choice: variant.supportsTools ? request.tool_choice : undefined,
      ...(sanitizedRequest.reasoning_effort !== undefined
        ? { reasoning_effort: variant.tier }
        : {}),
      ...(request.reasoning?.effort !== undefined
        ? {
            reasoning: {
              ...request.reasoning,
              ...(request.reasoning_effort === undefined ? { effort: variant.tier } : {}),
            },
          }
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
    return { request: { ...applied.request, model: physicalModel }, variant: null };
  }

  if (getServerConfig()?.thinking_budget?.control_source === 'client') {
    return { request: { ...applied.request, model: variant.model }, variant };
  }

  return {
    request: restoreOpenAIEffortAfterVariant(
      {
        ...applied.request,
        model: variant.model,
        thinking:
          variant.thinkingBudget === 0
            ? undefined
            : {
                type: 'enabled',
                budget_tokens: variant.thinkingBudget,
              },
        tools: variant.supportsTools ? applied.request.tools : undefined,
        tool_choice: variant.supportsTools ? applied.request.tool_choice : undefined,
        ...(applied.request.reasoning_effort !== undefined
          ? { reasoning_effort: variant.tier }
          : {}),
        ...(applied.request.reasoning?.effort !== undefined
          ? { reasoning: { ...applied.request.reasoning, effort: variant.tier } }
          : {}),
      },
      applied.request,
    ),
    variant,
  };
}
