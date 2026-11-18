import {
  assertSupportedModelEffort,
  MODEL_EFFORT_TIERS,
  parseModelEffort,
  type ModelEffortTier,
} from '../../../common/model-effort';

const TIERED_MODEL_SUFFIXES = ['extra-low', 'low', 'medium', 'high', 'tiered'] as const;

export type TieredModelSuffix = ModelEffortTier | 'tiered';

export interface ParsedTieredModel {
  base: string;
  tier: TieredModelSuffix;
}

export function parseTieredModel(normalizedModel: string): ParsedTieredModel | null {
  for (const suffix of TIERED_MODEL_SUFFIXES) {
    const marker = `-${suffix}`;
    if (!normalizedModel.endsWith(marker)) {
      continue;
    }
    return { base: normalizedModel.slice(0, -marker.length), tier: suffix };
  }
  return null;
}

export function parseBareModelEffort(effort: string | undefined): ModelEffortTier | null {
  return parseModelEffort(effort);
}

export function assertSupportedBareModelEffort(effort: string | undefined): void {
  assertSupportedModelEffort(effort);
}

export function isBareModelFamilyAvailable(
  model: string,
  availableModels: ReadonlySet<string>,
): boolean {
  if (parseTieredModel(model)) {
    return false;
  }
  return [...availableModels].some((candidate) => parseTieredModel(candidate)?.base === model);
}

export function resolveBareFamilyModel(
  normalizedMappedModel: string,
  effort: string | undefined,
  availableModels: ReadonlySet<string>,
  requireKnownEffort = true,
): string | null {
  if (parseTieredModel(normalizedMappedModel)) {
    return null;
  }

  const familyCandidates = [...availableModels]
    .map((model) => ({ model, parsed: parseTieredModel(model) }))
    .filter(
      (item): item is { model: string; parsed: ParsedTieredModel } =>
        item.parsed?.base === normalizedMappedModel,
    );
  if (familyCandidates.length === 0) {
    return null;
  }

  const tiers = new Map<TieredModelSuffix, string>();
  for (const candidate of familyCandidates) {
    if (!tiers.has(candidate.parsed.tier)) {
      tiers.set(candidate.parsed.tier, candidate.model);
    }
  }

  const normalizedEffort = parseBareModelEffort(effort);
  if (requireKnownEffort && effort !== undefined && !normalizedEffort) {
    return null;
  }
  if (normalizedEffort) {
    return findClosestTier(normalizedEffort, tiers);
  }

  return (
    tiers.get('tiered') ??
    tiers.get('medium') ??
    findLowestTierAboveLow(tiers) ??
    tiers.get('low') ??
    familyCandidates[0]?.model ??
    null
  );
}

function findLowestTierAboveLow(tiers: ReadonlyMap<TieredModelSuffix, string>): string | undefined {
  const lowIndex = MODEL_EFFORT_TIERS.indexOf('low');
  for (const tier of MODEL_EFFORT_TIERS.slice(lowIndex + 1)) {
    const model = tiers.get(tier);
    if (model) {
      return model;
    }
  }
  return undefined;
}

function findClosestTier(
  targetTier: ModelEffortTier,
  tiers: ReadonlyMap<TieredModelSuffix, string>,
): string | null {
  const exact = tiers.get(targetTier);
  if (exact) {
    return exact;
  }
  const targetIndex = MODEL_EFFORT_TIERS.indexOf(targetTier);
  let closest: { model: string; distance: number; configuredIndex: number } | undefined;
  for (const [index, tier] of MODEL_EFFORT_TIERS.entries()) {
    const model = tiers.get(tier);
    if (!model) {
      continue;
    }
    const candidate = {
      model,
      distance: Math.abs(index - targetIndex),
      configuredIndex: index,
    };
    if (
      !closest ||
      candidate.distance < closest.distance ||
      (candidate.distance === closest.distance &&
        candidate.configuredIndex < closest.configuredIndex)
    ) {
      closest = candidate;
    }
  }
  return closest?.model ?? null;
}

function isPreferenceTier(tier: TieredModelSuffix): tier is ModelEffortTier {
  return tier !== 'tiered';
}
