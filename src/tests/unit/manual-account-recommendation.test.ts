import { describe, expect, it } from 'vitest';

import type { CloudAccount, CloudQuotaData } from '@/modules/cloud-account/types';
import {
  getManualAccountRecommendation,
  prioritizeRecommendedAccount,
} from '@/modules/cloud-account/utils/manual-account-recommendation';

const NOW = Date.parse('2026-09-28T00:00:00Z');

function createAccount(
  id: string,
  options: {
    active?: boolean;
    lastUsed?: number;
    models?: CloudQuotaData['models'];
    quotaGroups?: CloudQuotaData['quota_groups'];
    status?: CloudAccount['status'];
  } = {},
): CloudAccount {
  return {
    id,
    provider: 'google',
    email: `${id}@example.com`,
    token: {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
      expiry_timestamp: NOW + 3600,
      token_type: 'Bearer',
    },
    quota:
      options.models || options.quotaGroups
        ? {
            models: options.models ?? {},
            quota_groups: options.quotaGroups,
          }
        : undefined,
    created_at: 1,
    last_used: options.lastUsed ?? 1,
    status: options.status ?? 'active',
    is_active: options.active,
  };
}

function model(percentage: number, resetTime = '2026-09-28T05:00:00Z') {
  return { percentage, resetTime };
}

function weeklyGroup(
  groupName: string,
  percentage: number,
  resetTime: string,
): NonNullable<CloudQuotaData['quota_groups']>[number] {
  return {
    display_name: groupName,
    buckets: [
      {
        bucket_id: `${groupName.toLowerCase().replaceAll(' ', '-')}-weekly`,
        window: 'weekly',
        remaining_fraction: percentage / 100,
        reset_time: resetTime,
      },
    ],
  };
}

describe('manual account recommendation', () => {
  it('prefers the highest weekly balance inside the earliest 24-hour reset cohort', () => {
    const accounts = [
      createAccount('current', {
        active: true,
        models: { 'gemini-3-pro': model(100) },
        quotaGroups: [weeklyGroup('Gemini Pro Models', 100, '2026-09-28T04:00:00Z')],
      }),
      createAccount('earlier-low-balance', {
        models: { 'gemini-3-pro': model(90) },
        quotaGroups: [weeklyGroup('Gemini Pro Models', 20, '2026-09-28T10:00:00Z')],
      }),
      createAccount('same-day-high-balance', {
        models: { 'gemini-3-pro': model(70) },
        quotaGroups: [weeklyGroup('Gemini Pro Models', 80, '2026-09-28T20:00:00Z')],
      }),
      createAccount('later-cohort', {
        models: { 'gemini-3-pro': model(95) },
        quotaGroups: [weeklyGroup('Gemini Pro Models', 100, '2026-09-29T06:00:00Z')],
      }),
    ];

    expect(
      getManualAccountRecommendation(accounts, {
        sortKey: 'quota-pro3',
        modelVisibility: {},
        now: NOW,
      }),
    ).toEqual(
      expect.objectContaining({
        accountId: 'same-day-high-balance',
        context: 'pro3',
        fiveHourPercentage: 70,
        weeklyPercentage: 80,
      }),
    );
  });

  it('uses the selected model family and requires more than five percent five-hour quota', () => {
    const accounts = [
      createAccount('gemini-only', {
        models: { 'gemini-3-pro': model(100), 'claude-sonnet': model(5) },
        quotaGroups: [weeklyGroup('Claude Models', 100, '2026-09-28T08:00:00Z')],
      }),
      createAccount('claude-eligible', {
        models: { 'claude-sonnet': model(6) },
        quotaGroups: [weeklyGroup('Claude Models', 30, '2026-09-28T12:00:00Z')],
      }),
    ];

    expect(
      getManualAccountRecommendation(accounts, {
        sortKey: 'quota-claude',
        modelVisibility: {},
        now: NOW,
      })?.accountId,
    ).toBe('claude-eligible');
  });

  it('does not recommend accounts with stale, missing, or invalid weekly data', () => {
    const accounts = [
      createAccount('missing-weekly', { models: { 'gemini-3-flash': model(80) } }),
      createAccount('past-weekly', {
        models: { 'gemini-3-flash': model(80) },
        quotaGroups: [weeklyGroup('Gemini Flash Models', 80, '2026-09-27T23:00:00Z')],
      }),
      createAccount('invalid-weekly', {
        models: { 'gemini-3-flash': model(80) },
        quotaGroups: [weeklyGroup('Gemini Flash Models', 80, 'not-a-date')],
      }),
    ];

    expect(
      getManualAccountRecommendation(accounts, {
        sortKey: 'quota-flash',
        modelVisibility: {},
        now: NOW,
      }),
    ).toBeNull();
  });

  it('places the recommendation immediately after pinned active accounts', () => {
    const accounts = [
      createAccount('active-a', { active: true }),
      createAccount('active-b', { active: true }),
      createAccount('other-a'),
      createAccount('recommended'),
      createAccount('other-b'),
    ];

    expect(
      prioritizeRecommendedAccount(accounts, {
        accountId: 'recommended',
        context: 'overall',
        fiveHourPercentage: 60,
        weeklyPercentage: 80,
        weeklyResetTime: '2026-09-28T10:00:00Z',
      }).map((account) => account.id),
    ).toEqual(['active-a', 'active-b', 'recommended', 'other-a', 'other-b']);
  });
});
