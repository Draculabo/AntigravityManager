import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUOTA_GROUP_VISIBILITY,
  getVisibleAccountQuota,
  readQuotaGroupVisibility,
  saveQuotaGroupVisibility,
} from '@/modules/cloud-account/utils/quota-group-visibility';
import type { CloudQuotaData } from '@/modules/cloud-account/types';

const quota: CloudQuotaData = {
  models: {
    'gemini-3-pro': { percentage: 90, resetTime: '' },
    'claude-sonnet': { percentage: 80, resetTime: '' },
    'unknown-model': { percentage: 70, resetTime: '' },
  },
  quota_groups: ['Gemini', 'Claude', 'Unknown'].map((family) => ({
    display_name: `${family} Models`,
    buckets: ['5h', 'weekly'].map((window) => ({
      bucket_id: `${family.toLowerCase()}-${window}`,
      window,
      remaining_fraction: 0.8,
      reset_time: '',
    })),
  })),
};
describe('quota group display preferences', () => {
  it('keeps five-hour and weekly controls independent without mutating the quota snapshot', () => {
    const snapshot = structuredClone(quota);
    const result = getVisibleAccountQuota(
      quota,
      {},
      { fiveHour: { gemini: false, claude: true }, weekly: { gemini: true, claude: false } },
    );
    expect(Object.keys(result.models)).toEqual(['claude-sonnet', 'unknown-model']);
    expect(
      result.groups.map((group) => [
        group.display_name,
        group.buckets.map((bucket) => bucket.window),
      ]),
    ).toEqual([
      ['Gemini Models', ['weekly']],
      ['Claude Models', ['5h']],
      ['Unknown Models', ['5h', 'weekly']],
    ]);
    expect(result.weeklyItems.map((item) => item.groupName)).toEqual(['Gemini', 'Unknown']);
    expect(quota).toEqual(snapshot);
  });
  it('recognizes third-party bucket ids even when the group name is generic', () => {
    const result = getVisibleAccountQuota(
      {
        models: {},
        quota_groups: [
          {
            display_name: 'Models',
            buckets: [
              { bucket_id: '3p_weekly', window: 'weekly', remaining_fraction: 1, reset_time: '' },
            ],
          },
        ],
      },
      {},
      { ...DEFAULT_QUOTA_GROUP_VISIBILITY, weekly: { gemini: true, claude: false } },
    );
    expect(result.weeklyItems).toEqual([]);
    expect(result.weeklyHidden).toBe(true);
  });
  it('preserves unknown limits and actual missing-data states when both families are hidden', () => {
    const hidden = {
      fiveHour: { gemini: false, claude: false },
      weekly: { gemini: false, claude: false },
    };
    expect(
      getVisibleAccountQuota(quota, {}, hidden).weeklyItems.map((item) => item.groupName),
    ).toEqual(['Unknown']);
    expect(getVisibleAccountQuota(undefined, {}, hidden)).toEqual({
      models: {},
      providerModels: {},
      groups: [],
      weeklyItems: [],
      fiveHourHidden: false,
      weeklyHidden: false,
    });
  });
  it('round-trips all four settings and defaults to showing every group', () => {
    const storage = new Map<string, string>();
    const getter = () => ({
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    });
    const preference = {
      fiveHour: { gemini: false, claude: true },
      weekly: { gemini: true, claude: false },
    };
    expect(readQuotaGroupVisibility(getter)).toEqual(DEFAULT_QUOTA_GROUP_VISIBILITY);
    saveQuotaGroupVisibility(getter, preference);
    expect(readQuotaGroupVisibility(getter)).toEqual(preference);
    expect(readQuotaGroupVisibility(() => ({ ...getter(), getItem: () => '{broken' }))).toEqual(
      DEFAULT_QUOTA_GROUP_VISIBILITY,
    );
    expect(
      readQuotaGroupVisibility(() => ({
        ...getter(),
        getItem: () => '{"fiveHour":{"gemini":"false"}}',
      })),
    ).toEqual(DEFAULT_QUOTA_GROUP_VISIBILITY);
    const unavailable = () => {
      throw new Error('Storage unavailable');
    };
    expect(readQuotaGroupVisibility(unavailable)).toEqual(DEFAULT_QUOTA_GROUP_VISIBILITY);
    expect(() => saveQuotaGroupVisibility(unavailable, preference)).not.toThrow();
  });
});
