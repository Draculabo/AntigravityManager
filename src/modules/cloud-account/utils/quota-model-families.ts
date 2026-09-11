import type { CloudQuotaModelInfo } from '@/modules/cloud-account/types';

const FAMILY_DISPLAY_NAMES: Record<string, string> = {
  'gemini-3.1-pro': 'Gemini 3.1 Pro',
  'gemini-3.7-flash': 'Gemini 3.7 Flash',
  'gemini-3.5-flash': 'Gemini 3.5 Flash',
  'gemini-flash-lite': 'Gemini Flash Lite',
  'gemini-pro-image': 'Gemini Pro Image',
  'gemini-flash-image': 'Gemini Flash Image',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'claude-opus-4-6': 'Claude Opus 4.6',
  'claude-opus-4-5': 'Claude Opus 4.5',
  'gpt-oss-120b': 'GPT OSS 120B',
};

const EXACT_PRESENTATION_FAMILIES = new Set([
  'gemini-3.1-pro',
  'gemini-3.7-flash',
  'gemini-3.5-flash',
]);

function normalizeModelId(modelId: string): string {
  return modelId
    .replace(/^models\//i, '')
    .trim()
    .toLowerCase();
}

export function getQuotaModelFamilyId(modelId: string): string {
  const normalized = normalizeModelId(modelId);

  if (normalized.includes('image')) {
    if (normalized.startsWith('gemini-') && normalized.includes('flash')) {
      return 'gemini-flash-image';
    }
    if (normalized.startsWith('gemini-')) {
      return 'gemini-pro-image';
    }
  }

  if (
    normalized === 'gemini-3.1-flash-lite' ||
    normalized === 'gemini-2.5-flash-lite' ||
    normalized === 'gemini-2.5-flash' ||
    normalized === 'gemini-2.5-flash-thinking'
  ) {
    return 'gemini-flash-lite';
  }

  if (
    normalized.startsWith('gemini-3.1-pro') ||
    normalized === 'gemini-pro' ||
    normalized.startsWith('gemini-pro-agent')
  ) {
    return 'gemini-3.1-pro';
  }

  if (normalized.startsWith('gemini-3.7-flash') || normalized.startsWith('gemini-3.6-flash')) {
    return 'gemini-3.7-flash';
  }

  if (
    normalized.startsWith('gemini-3.5-flash') ||
    normalized === 'gemini-3-flash' ||
    normalized.startsWith('gemini-3-flash-agent')
  ) {
    return 'gemini-3.5-flash';
  }

  const claudeFamily = normalized.match(/^claude-(sonnet|opus|haiku)-(\d+)-(\d+)/);
  if (claudeFamily) {
    return `claude-${claudeFamily[1]}-${claudeFamily[2]}-${claudeFamily[3]}`;
  }

  if (normalized.startsWith('gpt-oss-120b')) {
    return 'gpt-oss-120b';
  }

  return normalized;
}

function chooseEarliestResetTime(current: string, candidate: string): string {
  if (!current) {
    return candidate;
  }
  if (!candidate) {
    return current;
  }

  const currentTimestamp = new Date(current).getTime();
  const candidateTimestamp = new Date(candidate).getTime();
  const currentIsValid = !Number.isNaN(currentTimestamp);
  const candidateIsValid = !Number.isNaN(candidateTimestamp);

  if (currentIsValid && candidateIsValid) {
    return candidateTimestamp < currentTimestamp ? candidate : current;
  }
  if (candidateIsValid) {
    return candidate;
  }
  return current;
}

/**
 * Collapse only known routing families. Unknown models remain independent,
 * including unknown ids containing words such as "thinking".
 */
export function aggregateQuotaModelFamilies(
  models: Record<string, CloudQuotaModelInfo>,
): Record<string, CloudQuotaModelInfo> {
  const aggregated: Record<string, CloudQuotaModelInfo> = {};

  for (const [modelId, info] of Object.entries(models)) {
    const normalizedModelId = normalizeModelId(modelId);
    const familyId = getQuotaModelFamilyId(normalizedModelId);
    const displayName = FAMILY_DISPLAY_NAMES[familyId];
    const current = aggregated[familyId];

    if (!current) {
      aggregated[familyId] =
        familyId === normalizedModelId && !displayName
          ? info
          : {
              ...info,
              display_name: displayName ?? info.display_name,
            };
      continue;
    }

    aggregated[familyId] = {
      ...current,
      percentage: Math.min(current.percentage, info.percentage),
      resetTime: chooseEarliestResetTime(current.resetTime, info.resetTime),
      display_name: displayName ?? current.display_name ?? info.display_name,
    };
  }

  return aggregated;
}

export function aggregateVisibleQuotaModelFamilies(
  models: Record<string, CloudQuotaModelInfo>,
  visibilitySettings: Record<string, boolean>,
): Record<string, CloudQuotaModelInfo> {
  const visibleFamilies = new Set<string>();
  for (const modelId of Object.keys(models)) {
    if (visibilitySettings[modelId] !== false) {
      visibleFamilies.add(getQuotaModelFamilyId(modelId));
    }
  }

  const visibleModels: Record<string, CloudQuotaModelInfo> = {};
  for (const [familyId, info] of Object.entries(aggregateQuotaModelFamilies(models))) {
    if (visibleFamilies.has(familyId)) {
      visibleModels[familyId] = info;
    }
  }
  return visibleModels;
}

/**
 * Keep conservative aggregation for summaries while exposing physical quota
 * slots for the tiered text families the product manages explicitly.
 */
export function getVisibleQuotaModelsForPresentation(
  models: Record<string, CloudQuotaModelInfo>,
  visibilitySettings: Record<string, boolean>,
): Record<string, CloudQuotaModelInfo> {
  const conservativeFamilies = aggregateQuotaModelFamilies(models);
  const entriesByFamily = new Map<string, Array<[string, CloudQuotaModelInfo]>>();

  for (const [modelId, info] of Object.entries(models)) {
    const normalizedModelId = normalizeModelId(modelId);
    const familyId = getQuotaModelFamilyId(normalizedModelId);
    const entries = entriesByFamily.get(familyId) ?? [];
    entries.push([modelId, info]);
    entriesByFamily.set(familyId, entries);
  }

  const visibleModels: Record<string, CloudQuotaModelInfo> = {};
  for (const [familyId, entries] of entriesByFamily) {
    const visibleEntries = entries.filter(([modelId]) => visibilitySettings[modelId] !== false);
    if (visibleEntries.length === 0) {
      continue;
    }

    if (EXACT_PRESENTATION_FAMILIES.has(familyId)) {
      for (const [modelId, info] of visibleEntries) {
        visibleModels[normalizeModelId(modelId)] = info;
      }
      continue;
    }

    visibleModels[familyId] = conservativeFamilies[familyId];
  }

  return visibleModels;
}
