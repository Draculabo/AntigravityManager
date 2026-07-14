import { differenceInHours, differenceInMinutes, isBefore } from 'date-fns';
import { CloudAccount } from '@/modules/cloud-account/types';

const HIGH_QUOTA_PERCENTAGE = 80;
const MEDIUM_QUOTA_PERCENTAGE = 20;
const CLAUDE_GROUP_PATTERN = /claude|gpt|3p/i;

export type QuotaStatus = 'high' | 'medium' | 'low';
export type AccountSortKey =
  | 'recently-used'
  | 'quota-overall'
  | 'quota-claude'
  | 'quota-pro3'
  | 'quota-flash';

export interface ResetTimeLabelOptions {
  prefix: string;
  unknown: string;
}

export function getQuotaStatus(percentage: number): QuotaStatus {
  if (percentage > HIGH_QUOTA_PERCENTAGE) {
    return 'high';
  }

  if (percentage > MEDIUM_QUOTA_PERCENTAGE) {
    return 'medium';
  }

  return 'low';
}

export function clampQuotaPercentage(percentage: number): number {
  return Math.max(0, Math.min(100, percentage));
}

export function roundQuotaPercentage(value: number): number {
  return Math.round(value * 10) / 10;
}

export function formatAiCreditsAmount(credits: number): string {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2,
  }).format(credits);
}

export function formatTimeRemaining(dateStr: string): string | null {
  const targetDate = new Date(dateStr);
  if (Number.isNaN(targetDate.getTime())) {
    return null;
  }

  const now = new Date();
  if (isBefore(targetDate, now)) {
    return '0h 0m';
  }

  const diffHrs = Math.max(0, differenceInHours(targetDate, now));
  const diffMins = Math.max(0, differenceInMinutes(targetDate, now) - diffHrs * 60);
  if (diffHrs >= 24) {
    const diffDays = Math.floor(diffHrs / 24);
    const remainingHrs = diffHrs % 24;
    return `${diffDays}d ${remainingHrs}h`;
  }

  return `${diffHrs}h ${diffMins}m`;
}

export function formatResetTimeLabel(
  resetTime: string | undefined,
  labels: ResetTimeLabelOptions,
): string {
  if (!resetTime) {
    return labels.unknown;
  }

  const remaining = formatTimeRemaining(resetTime);
  if (!remaining) {
    return labels.unknown;
  }

  return `${labels.prefix}: ${remaining}`;
}

export function formatResetTimeTitle(
  resetTime: string | undefined,
  resetTimeLabel: string,
): string | undefined {
  if (!resetTime) {
    return undefined;
  }

  const resetDate = new Date(resetTime);
  if (Number.isNaN(resetDate.getTime())) {
    return undefined;
  }

  return `${resetTimeLabel}: ${resetDate.toLocaleString()}`;
}

function getVisibleModelEntries(
  account: CloudAccount,
  modelVisibility: Record<string, boolean>,
): Array<[string, NonNullable<CloudAccount['quota']>['models'][string]]> {
  if (!account.quota?.models) return [];
  return Object.entries(account.quota.models).filter(
    ([modelName]) => modelVisibility[modelName] !== false,
  );
}

function getAveragePercentage(
  modelEntries: Array<[string, NonNullable<CloudAccount['quota']>['models'][string]]>,
): number {
  if (modelEntries.length === 0) {
    return 0;
  }

  return modelEntries.reduce((sum, [, model]) => sum + model.percentage, 0) / modelEntries.length;
}

export function getQuotaGroupBucketPercentages(account: CloudAccount, pattern?: RegExp): number[] {
  const groups = account.quota?.quota_groups ?? [];
  const percentages: number[] = [];

  for (const group of groups) {
    const groupText = [group.display_name, group.description].filter(Boolean).join(' ');
    const groupMatches = pattern ? pattern.test(groupText) : true;

    for (const bucket of group.buckets) {
      const bucketText = [bucket.bucket_id, bucket.window, bucket.display_name, bucket.description]
        .filter(Boolean)
        .join(' ');

      if (!groupMatches && pattern && !pattern.test(bucketText)) {
        continue;
      }

      percentages.push(Math.round(bucket.remaining_fraction * 100));
    }
  }

  return percentages;
}

function getMinimumPercentage(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return Math.min(...values);
}

function applyQuotaGroupLowerBound(modelScore: number, groupScore: number | null): number {
  if (groupScore === null) {
    return modelScore;
  }

  if (modelScore === 0) {
    return groupScore;
  }

  return Math.min(modelScore, groupScore);
}

export function getLowestEffectiveQuotaPercentage(account: CloudAccount): number | null {
  const modelPercentages = Object.values(account.quota?.models ?? {}).map(
    (model) => model.percentage,
  );
  const groupPercentages = getQuotaGroupBucketPercentages(account);

  return getMinimumPercentage([...modelPercentages, ...groupPercentages]);
}

function modelMatchesText(modelName: string, displayName: string | undefined, pattern: RegExp) {
  return pattern.test(modelName) || pattern.test(displayName || '');
}

export function getAccountSortValue(
  account: CloudAccount,
  sortKey: AccountSortKey,
  modelVisibility: Record<string, boolean> = {},
): number {
  const visibleModelEntries = getVisibleModelEntries(account, modelVisibility);
  if (visibleModelEntries.length === 0) {
    return 0;
  }

  switch (sortKey) {
    case 'quota-overall':
      return applyQuotaGroupLowerBound(
        getAveragePercentage(visibleModelEntries),
        getMinimumPercentage(getQuotaGroupBucketPercentages(account)),
      );
    case 'quota-claude': {
      const claude = visibleModelEntries.filter(([modelName, model]) =>
        modelMatchesText(modelName, model.display_name, /claude/i),
      );
      return applyQuotaGroupLowerBound(
        getAveragePercentage(claude),
        getMinimumPercentage(getQuotaGroupBucketPercentages(account, CLAUDE_GROUP_PATTERN)),
      );
    }
    case 'quota-pro3': {
      const pro3 = visibleModelEntries.filter(([modelName, model]) =>
        modelMatchesText(modelName, model.display_name, /pro/i),
      );
      return getAveragePercentage(pro3);
    }
    case 'quota-flash': {
      const flash = visibleModelEntries.filter(([modelName, model]) =>
        modelMatchesText(modelName, model.display_name, /flash/i),
      );
      return getAveragePercentage(flash);
    }
    default:
      return 0;
  }
}
