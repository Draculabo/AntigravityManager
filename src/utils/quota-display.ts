import { differenceInHours, differenceInMinutes, isBefore } from 'date-fns';
import { CloudAccount } from '@/types/cloudAccount';

const HIGH_QUOTA_PERCENTAGE = 80;
const MEDIUM_QUOTA_PERCENTAGE = 20;

export type QuotaStatus = 'high' | 'medium' | 'low';

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

export function getAccountSortValue(account: CloudAccount, sortKey: string): number {
  if (!account.quota?.models) return 0;
  const models = Object.values(account.quota.models);
  if (models.length === 0) return 0;

  switch (sortKey) {
    case 'quota-overall':
      return models.reduce((sum, m) => sum + m.percentage, 0) / models.length;
    case 'quota-claude': {
      const claude = models.filter((m) => m.percentage > 0);
      return claude.length > 0
        ? claude.reduce((sum, m) => sum + m.percentage, 0) / claude.length
        : 0;
    }
    case 'quota-pro3': {
      const pro3 = models.filter((m) => m.percentage > 0 && /pro/i.test(m.display_name || ''));
      return pro3.length > 0 ? pro3.reduce((sum, m) => sum + m.percentage, 0) / pro3.length : 0;
    }
    case 'quota-flash': {
      const flash = models.filter((m) => m.percentage > 0 && /flash/i.test(m.display_name || ''));
      return flash.length > 0 ? flash.reduce((sum, m) => sum + m.percentage, 0) / flash.length : 0;
    }
    default:
      return 0;
  }
}
