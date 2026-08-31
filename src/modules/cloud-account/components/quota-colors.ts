import type { QuotaStatus } from '@/modules/cloud-account/utils/quota-display';

export const QUOTA_TEXT_COLOR_CLASS_BY_STATUS: Record<QuotaStatus, string> = {
  high: 'text-emerald-600 dark:text-emerald-400 font-semibold',
  medium: 'text-amber-600 dark:text-amber-500 font-semibold',
  low: 'text-rose-600 dark:text-rose-400 font-semibold',
};

export const QUOTA_BAR_COLOR_CLASS_BY_STATUS: Record<QuotaStatus, string> = {
  high: 'bg-gradient-to-r from-emerald-400 to-teal-500 shadow-[0_0_8px_rgba(16,185,129,0.3)]',
  medium: 'bg-gradient-to-r from-amber-400 to-orange-500 shadow-[0_0_8px_rgba(245,158,11,0.25)]',
  low: 'bg-gradient-to-r from-rose-500 to-red-600 shadow-[0_0_8px_rgba(239,68,68,0.3)]',
};
