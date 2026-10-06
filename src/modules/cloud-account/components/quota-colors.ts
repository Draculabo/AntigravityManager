import type { QuotaStatus } from '@/modules/cloud-account/utils/quota-display';

export const QUOTA_TEXT_COLOR_CLASS_BY_STATUS: Record<QuotaStatus, string> = {
  high: 'text-success font-semibold',
  medium: 'text-warning font-semibold',
  low: 'text-destructive font-semibold',
};

export const QUOTA_BAR_COLOR_CLASS_BY_STATUS: Record<QuotaStatus, string> = {
  high: 'bg-success',
  medium: 'bg-warning',
  low: 'bg-destructive',
};
