import { getServerConfig } from '@/server/server-config';
import { detectsNetworkingTool } from './AntigravityRequestTools';
import type { AntigravityGenerationInput } from './generation-input';
import {
  resolveImageGenerationConfig,
  type ImageGenerationConfigInput,
} from './ImageGenerationConfig';
import { normalizeObjectJsonSchema } from './JsonSchemaUtils';
import { normalizeGeminiModelAlias } from './ModelMapping';
import { getThinkingBudget } from './ModelSpecs';
import { isGeminiFlashModel } from './ThoughtSignatureCompat';
import type { GenerationConfig, ImageConfig, Tool } from './types';

/**
 * Request Configuration
 * Contains request type, model, and image generation configuration
 */
export interface ResolvedRequestConfig {
  /** Request type: 'agent', 'web_search', 'image_gen' */
  requestType: RequestType;
  /** Whether to inject Google Search tool */
  injectGoogleSearch: boolean;
  /** Final model name to use */
  finalModel: string;
  /** Image generation config (only for image generation requests) */
  imageConfig: ImageConfig | null;
}

type RequestType = 'agent' | 'web_search' | 'image_gen';

/**
 * Resolves request configuration
 * Determines request type and whether to inject search tools based on model name and tools
 */
export function resolveRequestConfig(
  originalModel: string,
  mappedModel: string,
  tools?: Tool[],
  imageRequest?: ImageGenerationConfigInput,
  preserveMappedImageModel = false,
): ResolvedRequestConfig {
  // 1. Image Generation Check
  if (isGeminiImageModel(mappedModel)) {
    const { imageConfig } = resolveImageGenerationConfig(originalModel, imageRequest);
    const { parsedBaseModel } = resolveImageGenerationConfig(mappedModel);
    return {
      requestType: 'image_gen',
      injectGoogleSearch: false,
      finalModel: preserveMappedImageModel
        ? parsedBaseModel
        : normalizeGeminiModelAlias(parsedBaseModel),
      imageConfig,
    };
  }

  const hasNetworkingTool = detectsNetworkingTool(tools);

  // Strip -online suffix
  const isOnlineSuffix = originalModel.endsWith('-online');

  const enableNetworking = isOnlineSuffix || hasNetworkingTool;

  let finalModel = mappedModel.replace(/-online$/, '');
  finalModel = normalizeGeminiModelAlias(finalModel);

  if (enableNetworking && !supportsWebSearchModel(finalModel)) {
    finalModel = 'gemini-3-flash';
  }

  return {
    requestType: enableNetworking ? 'web_search' : 'agent',
    injectGoogleSearch: enableNetworking,
    finalModel,
    imageConfig: null,
  };
}

function supportsWebSearchModel(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  return (
    normalized === 'gemini-2.5-flash' ||
    normalized === 'gemini-1.5-pro' ||
    normalized.startsWith('gemini-1.5-pro-') ||
    normalized.startsWith('gemini-2.5-flash-') ||
    normalized.startsWith('gemini-2.0-flash') ||
    normalized.startsWith('gemini-3-') ||
    normalized.startsWith('gemini-3.') ||
    normalized.startsWith('gemini-3.5-') ||
    normalized.startsWith('gemini-pro-') ||
    normalized.startsWith('agent') ||
    normalized.includes('claude-3-5-sonnet') ||
    normalized.includes('claude-3-opus') ||
    normalized.includes('claude-sonnet') ||
    normalized.includes('claude-opus') ||
    normalized.includes('claude-4')
  );
}

function isGeminiImageModel(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  return (
    normalized.startsWith('gemini-3-pro-image') ||
    normalized.startsWith('gemini-3.1-pro-image') ||
    normalized.startsWith('gemini-3-flash-image') ||
    normalized.startsWith('gemini-3.1-flash-image')
  );
}

function isGeminiAgentThinkingModel(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  return (
    normalized.includes('gemini') &&
    !normalized.includes('claude') &&
    (normalized.includes('gemini-pro') ||
      normalized.includes('-pro-agent') ||
      normalized.includes('-flash-agent'))
  );
}

export function targetModelSupportsThinking(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  const isTieredGeminiPro = /^gemini-3(?:\.1)?-pro-(high|low)$/.test(normalized);
  const isUntieredGeminiPro =
    (normalized.includes('gemini-3-pro') || normalized.includes('gemini-3.1-pro')) &&
    !isTieredGeminiPro &&
    !isGeminiImageModel(normalized);

  return (
    normalized.includes('-thinking') ||
    isClaudeModel(normalized) ||
    normalized.includes('gemini-2.0-pro') ||
    isUntieredGeminiPro ||
    isGeminiAgentThinkingModel(normalized) ||
    isGeminiFlashModel(normalized)
  );
}

export function shouldEnableThinkingByDefault(mappedModel: string, originalModel: string): boolean {
  const mappedLower = mappedModel.toLowerCase();
  const originalLower = originalModel.toLowerCase();
  return (
    originalLower.includes('claude-opus-4-5') ||
    originalLower.includes('claude-opus-4-6') ||
    mappedLower.includes('-thinking') ||
    mappedLower.includes('gemini-3.1-pro') ||
    isGeminiAgentThinkingModel(mappedLower) ||
    mappedLower.includes('gemini-3-flash') ||
    mappedLower.includes('gemini-3.1-flash')
  );
}

function isClaudeModel(modelName: string): boolean {
  return modelName.toLowerCase().includes('claude');
}

function resolveAdaptiveThinkingLevel(value?: string): 'low' | 'medium' | 'high' {
  const effort = String(value ?? '').toLowerCase();
  if (effort === 'low') {
    return 'low';
  }
  if (effort === 'medium') {
    return 'medium';
  }
  return 'high';
}

export function buildGenerationConfig(
  input: AntigravityGenerationInput,
  hasWebSearch: boolean,
  mappedModel: string,
  isThinkingEnabled: boolean,
  schemasPrepared: boolean,
): GenerationConfig {
  const config: GenerationConfig = {};
  const { output, parameters, thinking } = input;
  const thinkingType = String(thinking?.type ?? '').toLowerCase();
  const clientControlled = getServerConfig()?.thinking_budget?.control_source === 'client';

  const buildThinkingConfig = (): GenerationConfig['thinkingConfig'] => {
    const thinkingConfig: GenerationConfig['thinkingConfig'] = { includeThoughts: true };
    if (clientControlled) {
      const budget = thinking?.budgetTokens;
      const effort = thinking?.effort ?? input.outputEffort;
      if (budget !== undefined) {
        thinkingConfig.thinkingBudget = budget;
      } else if (effort !== undefined) {
        thinkingConfig.thinkingLevel = effort;
      } else {
        thinkingConfig.thinkingBudget = -1;
      }
      return thinkingConfig;
    }
    if (thinkingType === 'adaptive') {
      if (isClaudeModel(mappedModel)) {
        thinkingConfig.thinkingLevel = resolveAdaptiveThinkingLevel(thinking?.effort);
      } else {
        thinkingConfig.thinkingBudget = 24576;
      }
    } else if (thinking?.budgetTokens) {
      let budget = thinking.budgetTokens;
      const isFlash = hasWebSearch || isGeminiFlashModel(mappedModel);
      if (isFlash) {
        budget = Math.min(budget, 24576);
      }
      thinkingConfig.thinkingBudget = budget;
    } else {
      thinkingConfig.thinkingBudget = getThinkingBudget(mappedModel);
    }
    return thinkingConfig;
  };

  if (output) {
    config.responseMimeType = 'application/json';
  }
  if (output?.kind === 'json-schema') {
    config.responseSchema = schemasPrepared
      ? structuredClone(output.schema)
      : normalizeObjectJsonSchema(output.schema, undefined, 'output');
  }

  const thinkingConfig = isThinkingEnabled ? { thinkingConfig: buildThinkingConfig() } : {};
  return input.thinkingAfterParameters
    ? { ...config, ...parameters, ...thinkingConfig }
    : { ...config, ...thinkingConfig, ...parameters };
}
