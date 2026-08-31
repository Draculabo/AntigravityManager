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
