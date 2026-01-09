const logger = {
  log: (msg: string) => console.log(msg),
  warn: (msg: string) => console.warn(msg),
};

const CLAUDE_TO_GEMINI: Record<string, string> = {
  // Directly supported models
  'claude-opus-4-5-thinking': 'claude-opus-4-5-thinking',
  'claude-sonnet-4-5': 'claude-sonnet-4-5',
  'claude-sonnet-4-5-thinking': 'claude-sonnet-4-5-thinking',

  // Alias mappings
  'claude-sonnet-4-5-20250929': 'claude-sonnet-4-5-thinking',
  'claude-3-5-sonnet-20241022': 'claude-sonnet-4-5',
  'claude-3-5-sonnet-20240620': 'claude-sonnet-4-5',
  'claude-opus-4': 'claude-opus-4-5-thinking',
  'claude-opus-4-5-20251101': 'claude-opus-4-5-thinking',
  'claude-haiku-4': 'claude-sonnet-4-5',
  'claude-3-haiku-20240307': 'claude-sonnet-4-5',
  'claude-haiku-4-5-20251001': 'claude-sonnet-4-5',

  // OpenAI Protocol Mapping
  'gpt-4': 'gemini-2.5-pro',
  'gpt-4-turbo': 'gemini-2.5-pro',
  'gpt-4-turbo-preview': 'gemini-2.5-pro',
  'gpt-4-0125-preview': 'gemini-2.5-pro',
  'gpt-4-1106-preview': 'gemini-2.5-pro',
  'gpt-4-0613': 'gemini-2.5-pro',

  'gpt-4o': 'gemini-2.5-pro',
  'gpt-4o-2024-05-13': 'gemini-2.5-pro',
  'gpt-4o-2024-08-06': 'gemini-2.5-pro',

  'gpt-4o-mini': 'gemini-2.5-flash',
  'gpt-4o-mini-2024-07-18': 'gemini-2.5-flash',

  'gpt-3.5-turbo': 'gemini-2.5-flash',
  'gpt-3.5-turbo-16k': 'gemini-2.5-flash',
  'gpt-3.5-turbo-0125': 'gemini-2.5-flash',
  'gpt-3.5-turbo-1106': 'gemini-2.5-flash',
  'gpt-3.5-turbo-0613': 'gemini-2.5-flash',

  // Gemini Protocol Mapping
  'gemini-2.5-flash-lite': 'gemini-2.5-flash-lite',
  'gemini-2.5-flash-thinking': 'gemini-2.5-flash-thinking',
  'gemini-3-pro-low': 'gemini-3-pro-low',
  'gemini-3-pro-high': 'gemini-3-pro-high',
  'gemini-3-pro-preview': 'gemini-3-pro-preview',
  'gemini-2.5-flash': 'gemini-2.5-flash',
  'gemini-3-flash': 'gemini-3-flash',
  'gemini-3-pro-image': 'gemini-3-pro-image',
};

export function mapClaudeModelToGemini(input: string): string {
  // 1. Check exact match in map
  if (CLAUDE_TO_GEMINI[input]) {
    return CLAUDE_TO_GEMINI[input];
  }

  // 2. Pass-through known prefixes (gemini-, -thinking) to support dynamic suffixes
  if (input.startsWith('gemini-') || input.includes('thinking')) {
    return input;
  }

  // 3. Fallback to default
  return 'claude-sonnet-4-5';
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
  // 1. Check custom exact mapping (Highest priority)
  if (customMapping[originalModel]) {
    logger.log(
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
      logger.log(
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
      logger.log(
        `[Router] Using GPT-4o/3.5 series mapping: ${originalModel} -> ${openaiMapping['gpt-4o-series']}`,
      );
      return openaiMapping['gpt-4o-series'];
    }
  }

  // GPT-5 Series (gpt-5, gpt-5.1, gpt-5.2, etc.)
  if (lowerModel.startsWith('gpt-5')) {
    // Prefer gpt-5-series mapping, fallback to gpt-4-series if missing
    if (openaiMapping['gpt-5-series']) {
      logger.log(
        `[Router] Using GPT-5 series mapping: ${originalModel} -> ${openaiMapping['gpt-5-series']}`,
      );
      return openaiMapping['gpt-5-series'];
    }
    if (openaiMapping['gpt-4-series']) {
      logger.log(
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
