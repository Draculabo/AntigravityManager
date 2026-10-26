import type { CloudQuotaGroup } from '../types';

export type QuotaGroupModelMembership = 'authoritative' | 'legacy' | 'unknown';

export function normalizeQuotaModelId(modelId: string): string {
  return modelId
    .trim()
    .replace(/^models\//i, '')
    .toLowerCase();
}

/**
 * Provider model IDs are stronger evidence than a human-readable group label.
 * A missing list keeps the historical matcher available, but is explicitly
 * classified as legacy so callers cannot present it as an official membership.
 */
export function getQuotaGroupModelMembership(
  group: CloudQuotaGroup,
  modelId: string,
): QuotaGroupModelMembership {
  const normalizedModelId = normalizeQuotaModelId(modelId);
  if (!normalizedModelId) {
    return 'unknown';
  }

  if (group.model_ids !== undefined) {
    return group.model_ids.some(
      (candidate) => normalizeQuotaModelId(candidate) === normalizedModelId,
    )
      ? 'authoritative'
      : 'unknown';
  }

  return 'legacy';
}
