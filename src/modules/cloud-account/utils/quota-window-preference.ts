import type { QuotaWindow } from '@/modules/cloud-account/utils/quota-groups';

export const QUOTA_WINDOW_STORAGE_KEY = 'accounts_quota_window';

interface QuotaWindowStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readQuotaWindowPreference(
  storage: QuotaWindowStorage | (() => QuotaWindowStorage),
): QuotaWindow {
  try {
    const resolved = typeof storage === 'function' ? storage() : storage;
    return resolved.getItem(QUOTA_WINDOW_STORAGE_KEY) === 'weekly' ? 'weekly' : '5h';
  } catch {
    return '5h';
  }
}

export function saveQuotaWindowPreference(
  storage: QuotaWindowStorage | (() => QuotaWindowStorage),
  quotaWindow: QuotaWindow,
): void {
  try {
    const resolved = typeof storage === 'function' ? storage() : storage;
    resolved.setItem(QUOTA_WINDOW_STORAGE_KEY, quotaWindow);
  } catch {
    // The preference is optional when browser storage is unavailable.
  }
}
