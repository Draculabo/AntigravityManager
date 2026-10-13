import { describe, expect, it, vi } from 'vitest';
import {
  readMinimalModePreference,
  saveMinimalModePreference,
  isGeminiWeeklyQuotaItem,
  isGeminiQuotaGroup,
} from '@/modules/cloud-account/utils/minimal-mode-preference';
import type { WeeklyQuotaItem } from '@/modules/cloud-account/utils/quota-groups';

describe('minimal-mode preference', () => {
  it('defaults to false when storage is empty or contains unexpected values', () => {
    expect(readMinimalModePreference({ getItem: () => null, setItem: vi.fn() })).toBe(false);
    expect(readMinimalModePreference({ getItem: () => 'foo', setItem: vi.fn() })).toBe(false);
  });

  it('reads true when storage has true string', () => {
    expect(readMinimalModePreference({ getItem: () => 'true', setItem: vi.fn() })).toBe(true);
  });

  it('saves preference to storage correctly', () => {
    const setItem = vi.fn();
    saveMinimalModePreference({ getItem: () => null, setItem }, true);
    expect(setItem).toHaveBeenCalledWith('accounts_minimal_mode', 'true');

    saveMinimalModePreference({ getItem: () => null, setItem }, false);
    expect(setItem).toHaveBeenCalledWith('accounts_minimal_mode', 'false');
  });

  it('handles throwing storage gracefully without unhandled error', () => {
    const brokenStorage = {
      getItem: () => {
        throw new Error('Access denied');
      },
      setItem: () => {
        throw new Error('Access denied');
      },
    };
    expect(readMinimalModePreference(brokenStorage)).toBe(false);
    expect(() => saveMinimalModePreference(brokenStorage, true)).not.toThrow();
  });
});

describe('isGeminiWeeklyQuotaItem', () => {
  it('correctly matches Gemini weekly items', () => {
    const geminiItem: WeeklyQuotaItem = {
      id: 'gemini-1',
      groupName: 'Gemini',
      bucketLabel: 'Weekly Limit Remaining',
      percentage: 55,
      resetTime: '2099-01-01T00:00:00Z',
      bucket: {
        bucket_id: 'gemini_weekly',
        window: 'WEEKLY',
        display_name: 'Weekly Limit Remaining',
        remaining_fraction: 0.55,
        reset_time: '2099-01-01T00:00:00Z',
      },
    };
    expect(isGeminiWeeklyQuotaItem(geminiItem)).toBe(true);
  });

  it('correctly filters out Claude and GPT weekly items', () => {
    const claudeItem: WeeklyQuotaItem = {
      id: 'claude-1',
      groupName: 'Claude and GPT',
      bucketLabel: 'Weekly Limit Remaining',
      percentage: 100,
      resetTime: '2099-01-01T00:00:00Z',
      bucket: {
        bucket_id: 'claude_weekly',
        window: 'WEEKLY',
        display_name: 'Weekly Limit Remaining',
        remaining_fraction: 1.0,
        reset_time: '2099-01-01T00:00:00Z',
      },
    };
    expect(isGeminiWeeklyQuotaItem(claudeItem)).toBe(false);
  });
});

describe('isGeminiQuotaGroup', () => {
  it('correctly matches Gemini Models quota group', () => {
    const geminiGroup = {
      display_name: 'Gemini Models',
      description: 'Models within this group: Gemini Flash, Gemini Pro',
      buckets: [
        {
          bucket_id: 'five-hour',
          window: '5h',
          display_name: 'Five Hour Limit Remaining',
          remaining_fraction: 1.0,
          reset_time: '2099-01-01T04:59:00Z',
        },
      ],
    };
    expect(isGeminiQuotaGroup(geminiGroup)).toBe(true);
  });

  it('correctly filters out Claude and GPT quota group', () => {
    const claudeGroup = {
      display_name: 'Claude and GPT models',
      description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
      buckets: [
        {
          bucket_id: 'five-hour',
          window: '5h',
          display_name: 'Five Hour Limit Remaining',
          remaining_fraction: 1.0,
          reset_time: '2099-01-01T04:59:00Z',
        },
      ],
    };
    expect(isGeminiQuotaGroup(claudeGroup)).toBe(false);
  });
});
