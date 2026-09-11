import type { CloudQuotaBucket, CloudQuotaGroup } from '@/modules/cloud-account/types';

export type QuotaWindow = '5h' | 'weekly';

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

/**
 * Collect every bucket percentage backed by positive metadata evidence.
 * Omitting tokens selects all groups; an empty token list selects none.
 */
export function collectQuotaGroupBucketPercentages(
  groups: CloudQuotaGroup[] | undefined,
  matchTokens?: readonly string[],
): number[] {
  const normalizedTokens = matchTokens
    ?.map(normalizeQuotaMatchToken)
    .filter((token) => token.length > 0);
  const percentages: number[] = [];

  for (const group of groups ?? []) {
    const groupMatches =
      normalizedTokens === undefined ||
      metadataMatchesTokens([group.display_name, group.description], normalizedTokens);

    for (const bucket of group.buckets) {
      const bucketMatches =
        groupMatches ||
        (normalizedTokens !== undefined &&
          metadataMatchesTokens(
            [bucket.bucket_id, bucket.window, bucket.display_name, bucket.description],
            normalizedTokens,
          ));

      if (bucketMatches) {
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

export function selectWeeklyQuotaItems(groups: CloudQuotaGroup[] | undefined): WeeklyQuotaItem[] {
  return (groups ?? []).flatMap((group) =>
    group.buckets.filter(isWeeklyQuotaBucket).map((bucket) => ({
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
