import type { CloudQuotaBucket, CloudQuotaGroup } from '@/modules/cloud-account/types';
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
