import type {
  CloudQuotaBucket,
  CloudQuotaGroup,
  CloudQuotaModelInfo,
} from '@/modules/cloud-account/types';
import {
  getQuotaModelFamilyId,
  getQuotaModelFamilyIdByDisplayName,
} from '@/modules/cloud-account/utils/quota-model-families';

export type QuotaWindow = 'both' | '5h' | 'weekly';

export interface WeeklyQuotaItem {
  id: string;
  groupName: string;
  groupDescription?: string;
  bucketLabel: string;
  percentage: number;
  resetTime: string;
  bucket: CloudQuotaBucket;
}

function normalizeQuotaMatchToken(value: string): string {
  return value
    .replace(/^models\//i, '')
    .trim()
    .toLowerCase();
}

function metadataMatchesTokens(values: Array<string | undefined>, tokens: readonly string[]) {
  const text = values.filter(Boolean).join(' ').toLowerCase();
  return tokens.some((token) => text.includes(token));
}

function normalizeQuotaMatchTokens(matchTokens?: readonly string[]): string[] | undefined {
  return matchTokens?.map(normalizeQuotaMatchToken).filter((token) => token.length > 0);
}

/**
 * Returns the model family a group limits when Google names the group after one registered family,
 * such as "Gemini 4 Argon". Provider-wide groups such as "Gemini Models" return undefined.
 */
export function getDedicatedQuotaGroupFamilyId(
  group: Pick<CloudQuotaGroup, 'display_name'>,
): string | undefined {
  return getQuotaModelFamilyIdByDisplayName(group.display_name);
}

function bucketMatchesTokens(
  group: CloudQuotaGroup,
  bucket: CloudQuotaBucket,
  normalizedTokens: readonly string[] | undefined,
): boolean {
  if (normalizedTokens === undefined) {
    return true;
  }

  // A dedicated group's metadata also names its provider, so provider tokens must not match it.
  const dedicatedFamilyId = getDedicatedQuotaGroupFamilyId(group);
  if (dedicatedFamilyId !== undefined) {
    return normalizedTokens.some((token) => getQuotaModelFamilyId(token) === dedicatedFamilyId);
  }

  return (
    metadataMatchesTokens([group.display_name, group.description], normalizedTokens) ||
    metadataMatchesTokens(
      [bucket.bucket_id, bucket.window, bucket.display_name, bucket.description],
      normalizedTokens,
    )
  );
}

/**
 * Collect every bucket percentage backed by positive metadata evidence.
 * Omitting tokens selects all groups; an empty token list selects none.
 */
export function collectQuotaGroupBucketPercentages(
  groups: CloudQuotaGroup[] | undefined,
  matchTokens?: readonly string[],
): number[] {
  const normalizedTokens = normalizeQuotaMatchTokens(matchTokens);
  const percentages: number[] = [];

  for (const group of groups ?? []) {
    for (const bucket of group.buckets) {
      if (bucketMatchesTokens(group, bucket, normalizedTokens)) {
        percentages.push(Math.round(bucket.remaining_fraction * 100));
      }
    }
  }

  return percentages;
}

export function getMinimumQuotaPercentage(values: readonly number[]): number | null {
  return values.length > 0 ? Math.min(...values) : null;
}

export function applyQuotaLowerBound(
  modelScore: number | null,
  groupScore: number | null,
): number | null {
  if (modelScore === null) {
    return groupScore;
  }
  if (groupScore === null) {
    return modelScore;
  }
  return Math.min(modelScore, groupScore);
}

export function isWeeklyQuotaBucket(bucket: CloudQuotaBucket): boolean {
  return `${bucket.window} ${bucket.bucket_id}`.toLowerCase().includes('week');
}

export function selectWeeklyQuotaItems(
  groups: CloudQuotaGroup[] | undefined,
  matchTokens?: readonly string[],
): WeeklyQuotaItem[] {
  const normalizedTokens = normalizeQuotaMatchTokens(matchTokens);

  return (groups ?? []).flatMap((group) =>
    group.buckets
      .filter(
        (bucket) =>
          isWeeklyQuotaBucket(bucket) && bucketMatchesTokens(group, bucket, normalizedTokens),
      )
      .map((bucket) => ({
        id: `${group.display_name}:${bucket.bucket_id}:${bucket.window}:${bucket.reset_time}`,
        groupName: group.display_name.replace(/\s+models?$/i, '').trim(),
        groupDescription: group.description,
        bucketLabel: bucket.display_name || bucket.window || bucket.bucket_id,
        percentage: Math.round(bucket.remaining_fraction * 100),
        resetTime: bucket.reset_time,
        bucket,
      })),
  );
}

/**
 * When Google's quota summary returns a dedicated quota group or weekly bucket for
 * Gemini 4 Argon but the upstream model catalog omits it from models, synthesize
 * gemini-4-argon-high into the account models map so it can be managed in visibility settings,
 * selected in playground, and scheduled through the proxy gateway.
 */
export function populateSyntheticArgonModels(
  models: Record<string, CloudQuotaModelInfo>,
  quotaGroups?: readonly CloudQuotaGroup[],
): void {
  if (!quotaGroups || quotaGroups.length === 0) {
    return;
  }

  const hasArgonModel = Object.keys(models).some((key) => {
    const normalized = key.replace(/^models\//i, '').toLowerCase();
    return normalized.startsWith('gemini-4-argon');
  });

  if (hasArgonModel) {
    return;
  }

  for (const group of quotaGroups) {
    const isArgonGroup =
      getDedicatedQuotaGroupFamilyId(group) === 'gemini-4-argon' ||
      group.display_name.toLowerCase().includes('argon') ||
      group.buckets.some((b) => b.bucket_id.toLowerCase().includes('argon'));

    if (!isArgonGroup) {
      continue;
    }

    const bucket =
      group.buckets.find((b) => b.bucket_id.toLowerCase().includes('argon')) ?? group.buckets[0];
    if (!bucket) {
      continue;
    }

    const fraction = bucket.remaining_fraction ?? 1;
    const percentage = Math.floor(fraction * 100);
    const resetTime = bucket.reset_time || '';

    models['gemini-4-argon-high'] = {
      percentage,
      resetTime,
      display_name: 'Gemini 4 Argon (High)',
      supports_images: true,
      supports_thinking: true,
      thinking_budget: 49152,
      recommended: false,
      max_tokens: 1048576,
      max_output_tokens: 65536,
    };
    break;
  }
}
