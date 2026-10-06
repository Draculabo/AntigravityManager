import type { AccountSortKey, QuotaStatus } from '@/modules/cloud-account/utils/quota-display';

export type GridLayout = 'auto' | '2-col' | '3-col' | 'list' | 'compact';

export const GRID_LAYOUT_CLASSES: Record<GridLayout, string> = {
  auto: 'grid gap-4 md:grid-cols-2 xl:grid-cols-3',
  '2-col': 'grid gap-4 grid-cols-2',
  '3-col': 'grid gap-4 grid-cols-3',
  list: 'grid gap-4 grid-cols-1',
  compact: 'flex flex-col gap-2',
};

export const GLOBAL_QUOTA_BAR_COLOR_CLASS_BY_STATUS: Record<QuotaStatus, string> = {
  high: 'bg-success',
  medium: 'bg-warning',
  low: 'bg-destructive',
};

export const GLOBAL_QUOTA_TEXT_COLOR_CLASS_BY_STATUS: Record<QuotaStatus, string> = {
  high: 'text-success font-semibold',
  medium: 'text-warning font-semibold',
  low: 'text-destructive font-semibold',
};

export const CLOUD_ACCOUNT_SORT_OPTIONS = [
  'recently-used',
  'quota-overall',
  'quota-claude',
  'quota-pro3',
  'quota-flash',
] as const;

export const CLOUD_ACCOUNT_SORT_I18N_KEYS: Record<AccountSortKey, string> = {
  'recently-used': 'cloud.sort.recentlyUsed',
  'quota-overall': 'cloud.sort.quotaOverall',
  'quota-claude': 'cloud.sort.quotaClaude',
  'quota-pro3': 'cloud.sort.quotaPro3',
  'quota-flash': 'cloud.sort.quotaFlash',
};
