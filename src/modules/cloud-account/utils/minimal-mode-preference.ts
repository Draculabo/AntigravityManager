import type { CloudQuotaGroup } from '@/modules/cloud-account/types';
import type { WeeklyQuotaItem } from '@/modules/cloud-account/utils/quota-groups';

export const MINIMAL_MODE_STORAGE_KEY = 'accounts_minimal_mode';

interface MinimalModeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readMinimalModePreference(
  storage: MinimalModeStorage | (() => MinimalModeStorage),
): boolean {
  try {
    const resolved = typeof storage === 'function' ? storage() : storage;
    const value = resolved.getItem(MINIMAL_MODE_STORAGE_KEY);
    return value === 'true';
  } catch {
    return false;
  }
}

export function saveMinimalModePreference(
  storage: MinimalModeStorage | (() => MinimalModeStorage),
  enabled: boolean,
): void {
  try {
    const resolved = typeof storage === 'function' ? storage() : storage;
    resolved.setItem(MINIMAL_MODE_STORAGE_KEY, enabled ? 'true' : 'false');
  } catch {
    // The preference is optional when browser storage is unavailable.
  }
}

/**
 * Identifies whether a weekly quota item belongs to the Gemini family.
 */
export function isGeminiWeeklyQuotaItem(item: WeeklyQuotaItem): boolean {
  const targetText = [
    item.groupName,
    item.groupDescription,
    item.bucketLabel,
    item.bucket?.bucket_id,
    item.bucket?.display_name,
    item.bucket?.description,
  ]
    .filter(Boolean)
    .join(' ');

  return /gemini/i.test(targetText);
}

/**
 * Identifies whether a weekly quota item belongs to Claude or GPT.
 */
export function isClaudeOrGptWeeklyQuotaItem(item: WeeklyQuotaItem): boolean {
  const targetText = [
    item.groupName,
    item.groupDescription,
    item.bucketLabel,
    item.bucket?.bucket_id,
    item.bucket?.display_name,
    item.bucket?.description,
  ]
    .filter(Boolean)
    .join(' ');

  return /claude|gpt|3p/i.test(targetText);
}

/**
 * Identifies whether a detailed quota group belongs to the Gemini family.
 */
export function isGeminiQuotaGroup(group: CloudQuotaGroup): boolean {
  const targetText = [
    group.display_name,
    group.description,
    ...group.buckets.flatMap((b) => [b.bucket_id, b.display_name, b.description]),
  ]
    .filter(Boolean)
    .join(' ');

  return /gemini/i.test(targetText);
}

/**
 * Identifies whether a detailed quota group belongs to Claude or GPT.
 */
export function isClaudeOrGptQuotaGroup(group: CloudQuotaGroup): boolean {
  const targetText = [
    group.display_name,
    group.description,
    ...group.buckets.flatMap((b) => [b.bucket_id, b.display_name, b.description]),
  ]
    .filter(Boolean)
    .join(' ');

  return /claude|gpt|3p/i.test(targetText);
}
