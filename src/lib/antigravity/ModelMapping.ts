import { logger } from '../../utils/logger';

const PUBLIC_SUPPORTED_MODELS = [
  'gemini-3.1-pro-high',
  'gemini-3.1-pro-low',
  'gemini-3-flash',
  'claude-sonnet-4-6-thinking',
  'claude-opus-4-6-thinking',
] as const;

const CLAUDE_TO_GEMINI: Record<string, string> = {
  // Directly supported models
  'claude-sonnet-4-6-thinking': 'claude-sonnet-4-6-thinking',
  'claude-opus-4-6-thinking': 'claude-opus-4-6-thinking',
  'gemini-3.1-pro-low': 'gemini-3.1-pro-low',
  'gemini-3.1-pro-high': 'gemini-3.1-pro-high',
  'gemini-3-flash': 'gemini-3-flash',

  // Alias mappings
  'claude-sonnet-4-6': 'claude-sonnet-4-6-thinking',
  'claude-sonnet-4-6-20260219': 'claude-sonnet-4-6-thinking',
  'claude-sonnet-4-5': 'claude-sonnet-4-6-thinking',
  'claude-sonnet-4-5-thinking': 'claude-sonnet-4-6-thinking',
  'claude-sonnet-4-5-20250929': 'claude-sonnet-4-6-thinking',
  'claude-3-5-sonnet-20241022': 'claude-sonnet-4-6-thinking',
  'claude-3-5-sonnet-20240620': 'claude-sonnet-4-6-thinking',
  'claude-opus-4': 'claude-opus-4-6-thinking',
  'claude-opus-4-5-thinking': 'claude-opus-4-6-thinking',
  'claude-opus-4-5-20251101': 'claude-opus-4-6-thinking',
  'claude-opus-4-6': 'claude-opus-4-6-thinking',
  'claude-opus-4-6-20260201': 'claude-opus-4-6-thinking',
  'claude-haiku-4': 'claude-sonnet-4-6-thinking',
  'claude-3-haiku-20240307': 'claude-sonnet-4-6-thinking',
  'claude-haiku-4-5-20251001': 'claude-sonnet-4-6-thinking',

  // OpenAI Protocol Mapping
  'gpt-4': 'gemini-3-flash',
  'gpt-4-turbo': 'gemini-3-flash',
  'gpt-4-turbo-preview': 'gemini-3-flash',
  'gpt-4-0125-preview': 'gemini-3-flash',
  'gpt-4-1106-preview': 'gemini-3-flash',
  'gpt-4-0613': 'gemini-3-flash',

  'gpt-4o': 'gemini-3-flash',
  'gpt-4o-2024-05-13': 'gemini-3-flash',
  'gpt-4o-2024-08-06': 'gemini-3-flash',

  'gpt-4o-mini': 'gemini-3-flash',
  'gpt-4o-mini-2024-07-18': 'gemini-3-flash',

  'gpt-3.5-turbo': 'gemini-3-flash',
  'gpt-3.5-turbo-16k': 'gemini-3-flash',
  'gpt-3.5-turbo-0125': 'gemini-3-flash',
  'gpt-3.5-turbo-1106': 'gemini-3-flash',
  'gpt-3.5-turbo-0613': 'gemini-3-flash',

  // Gemini Protocol Mapping
  'gemini-2.5-flash-lite': 'gemini-3-flash',
  'gemini-3.1-pro-preview': 'gemini-3.1-pro-high',
  'gemini-3.1-pro': 'gemini-3.1-pro-high',
  'gemini-3.0-pro': 'gemini-3.1-pro-high',
  'gemini-2.5-flash': 'gemini-3-flash',
  'gemini-2.5-pro': 'gemini-3.1-pro-high',
  'gemini-2.0-flash': 'gemini-3-flash',
  'gemini-2.0-flash-online': 'gemini-3-flash',
  'gemini-3-pro-image': 'gemini-3-pro-image',
  'internal-background-task': 'gemini-3-flash',
};

const DYNAMIC_IMAGE_BASE_MODEL = 'gemini-3-pro-image';
const DYNAMIC_IMAGE_RESOLUTIONS = ['', '-2k', '-4k'];
const DYNAMIC_IMAGE_RATIOS = ['', '-1x1', '-4x3', '-3x4', '-16x9', '-9x16', '-21x9'];
const EXTRA_DYNAMIC_MODELS = ['gemini-3-flash', 'gemini-3.1-pro-high', 'gemini-3.1-pro-low'];

const DYNAMIC_MODEL_FORWARDING_RULES = new Map<string, string>();

export const MODEL_LIST_CREATED_AT = 1770652800;

export const MODEL_LIST_OWNER = 'antigravity';

const GEMINI_MODEL_ALIASES: Record<string, string> = {
  'gemini-3.1-pro': 'gemini-3.1-pro-high',
  'gemini-3.0-pro': 'gemini-3.1-pro-high',
  'gemini-3.1-pro-preview': 'gemini-3.1-pro-high',
  'gemini-3-pro-image-preview': 'gemini-3-pro-image',
  'gemini-3-flash-preview': 'gemini-3-flash',
};

export function getSupportedModels(): string[] {
  return [...PUBLIC_SUPPORTED_MODELS];
}

export function updateDynamicForwardingRules(oldModel: string, newModel: string): void {
  if (typeof oldModel !== 'string' || typeof newModel !== 'string') {
    return;
  }
  const normalizedOld = oldModel.trim();
  const normalizedNew = newModel.trim();
  if (!normalizedOld || !normalizedNew) {
    return;
  }
  if (!DYNAMIC_MODEL_FORWARDING_RULES.has(normalizedOld)) {
    logger.info(
      `[Router] Registered dynamic forwarding rule: ${normalizedOld} -> ${normalizedNew}`,
    );
  }
  DYNAMIC_MODEL_FORWARDING_RULES.set(normalizedOld, normalizedNew);
}

export function getDynamicForwardingTarget(modelId: string): string | undefined {
  return DYNAMIC_MODEL_FORWARDING_RULES.get(modelId);
}

export function getAllDynamicModels(
  customMapping: Record<string, string> = {},
  dynamicModelIds?: Iterable<string>,
): string[] {
  const modelIds = new Set<string>();

  for (const modelId of getSupportedModels()) {
    modelIds.add(modelId);
  }

  for (const customModelId of Object.keys(customMapping)) {
    modelIds.add(customModelId);
  }

  for (const resolution of DYNAMIC_IMAGE_RESOLUTIONS) {
    for (const ratio of DYNAMIC_IMAGE_RATIOS) {
      modelIds.add(`${DYNAMIC_IMAGE_BASE_MODEL}${resolution}${ratio}`);
    }
  }

  for (const modelId of EXTRA_DYNAMIC_MODELS) {
    modelIds.add(modelId);
  }

  if (dynamicModelIds) {
    for (const dynamicModelId of dynamicModelIds) {
      if (typeof dynamicModelId === 'string' && dynamicModelId.trim() !== '') {
        modelIds.add(dynamicModelId.trim());
      }
    }
  }

  return [...modelIds].filter((id) => !shouldHideDeprecatedModelFromList(id)).sort();
}

export function mapClaudeModelToGemini(input: string): string {
  if (!input || typeof input !== 'string') {
    return '';
  }
  const mappedModel = CLAUDE_TO_GEMINI[input];
  if (mappedModel) {
    return mappedModel;
  }

  return input;
}

export function normalizeGeminiModelAlias(modelId: string): string {
  const normalizedModelId = modelId.trim().toLowerCase();
  return GEMINI_MODEL_ALIASES[normalizedModelId] ?? modelId;
}

/**
 * Core Model Routing Engine
 * Priority: Custom Mapping (Exact) > Group Mapping (Family) > System Mapping (Built-in Plugin)
 */
export function resolveModelRoute(
  originalModel: string,
  customMapping: Record<string, string>,
  openaiMapping: Record<string, string>,
  anthropicMapping: Record<string, string>,
): string {
  const dynamicForwarded = getDynamicForwardingTarget(originalModel);
  if (dynamicForwarded && getSupportedModels().includes(dynamicForwarded)) {
    logger.info(
      `[Router] Dynamic deprecated-model forwarding: ${originalModel} -> ${dynamicForwarded}`,
    );
    return dynamicForwarded;
  }

  // 1. Check custom exact mapping (Highest priority)
  if (customMapping[originalModel]) {
    logger.info(
      `[Router] Using custom exact mapping: ${originalModel} -> ${customMapping[originalModel]}`,
    );
    return customMapping[originalModel];
  }

  const lowerModel = originalModel.toLowerCase();

  // 2. Check family group mapping (OpenAI Series)
  // GPT-4 Series (includes GPT-4 classic, o1, o3, etc., excludes 4o/mini/turbo)
  if (
    (lowerModel.startsWith('gpt-4') &&
      !lowerModel.includes('o') &&
      !lowerModel.includes('mini') &&
      !lowerModel.includes('turbo')) ||
    lowerModel.startsWith('o1-') ||
    lowerModel.startsWith('o3-') ||
    lowerModel === 'gpt-4'
  ) {
    if (openaiMapping['gpt-4-series']) {
      logger.info(
        `[Router] Using GPT-4 series mapping: ${originalModel} -> ${openaiMapping['gpt-4-series']}`,
      );
      return openaiMapping['gpt-4-series'];
    }
  }

  // GPT-4o / 3.5 Series (Balanced & Lightweight, includes 4o, mini, turbo)
  if (
    lowerModel.includes('4o') ||
    lowerModel.startsWith('gpt-3.5') ||
    (lowerModel.includes('mini') && !lowerModel.includes('gemini')) ||
    lowerModel.includes('turbo')
  ) {
    if (openaiMapping['gpt-4o-series']) {
      logger.info(
        `[Router] Using GPT-4o/3.5 series mapping: ${originalModel} -> ${openaiMapping['gpt-4o-series']}`,
      );
      return openaiMapping['gpt-4o-series'];
    }
  }

  // GPT-5 Series (gpt-5, gpt-5.1, gpt-5.2, etc.)
  if (lowerModel.startsWith('gpt-5')) {
    // Prefer gpt-5-series mapping, fallback to gpt-4-series if missing
    if (openaiMapping['gpt-5-series']) {
      logger.info(
        `[Router] Using GPT-5 series mapping: ${originalModel} -> ${openaiMapping['gpt-5-series']}`,
      );
      return openaiMapping['gpt-5-series'];
    }
    if (openaiMapping['gpt-4-series']) {
      logger.info(
        `[Router] Using GPT-4 series mapping (GPT-5 fallback): ${originalModel} -> ${openaiMapping['gpt-4-series']}`,
      );
      return openaiMapping['gpt-4-series'];
    }
  }

  // 3. Check family group mapping (Anthropic Series)
  if (lowerModel.startsWith('claude-')) {
    let familyKey = 'claude-default';
    if (lowerModel.includes('4-5') || lowerModel.includes('4.5')) {
      familyKey = 'claude-4.5-series';
    } else if (lowerModel.includes('3-5') || lowerModel.includes('3.5')) {
      familyKey = 'claude-3.5-series';
    }

    if (anthropicMapping[familyKey]) {
      logger.warn(
        `[Router] Using Anthropic series mapping: ${originalModel} -> ${anthropicMapping[familyKey]}`,
      );
      return anthropicMapping[familyKey];
    }

    // Fallback to legacy exact mapping
    if (anthropicMapping[originalModel]) {
      return anthropicMapping[originalModel];
    }
  }

  // 4. Fall through to system default mapping logic
  return mapClaudeModelToGemini(originalModel);
}

function shouldHideDeprecatedModelFromList(modelId: string): boolean {
  const normalized = modelId.toLowerCase();

  if (/^gemini-1(\.|$|-)/.test(normalized) || /^gemini-2(\.|$|-)/.test(normalized)) {
    return true;
  }

  if (normalized === 'gemini-3.1-pro' || normalized === 'gemini-3.1-pro-preview') {
    return true;
  }

  const isLegacyGeminiPro =
    /^gemini-3(\.0)?-pro($|-)/.test(normalized) && !normalized.startsWith('gemini-3-pro-image');
  if (isLegacyGeminiPro) {
    return true;
  }

  if (
    normalized.includes('claude-sonnet-4-5') ||
    normalized.includes('claude-opus-4-5') ||
    normalized.includes('claude-haiku-4-5')
  ) {
    return true;
  }

  return false;
}
