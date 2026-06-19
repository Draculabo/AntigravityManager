import { describe, expect, it } from 'vitest';
import type { CloudAccount, CloudQuotaData } from '@/modules/cloud-account/types';
import {
  ACCOUNT_TIER_UNKNOWN_KEY,
  buildAccountTierOptions,
  filterAndSortCloudAccounts,
  formatAccountTierLabel,
  getAccountTierKey,
} from '@/modules/cloud-account/utils/account-tier-filter';

function createAccount(
  id: string,
  options: {
    tier?: string;
    lastUsed?: number;
    active?: boolean;
    models?: CloudQuotaData['models'];
    quotaGroups?: CloudQuotaData['quota_groups'];
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
      expiry_timestamp: Date.now() + 3600,
      token_type: 'Bearer',
    },
    quota:
      options.tier || options.models || options.quotaGroups
        ? {
            subscription_tier: options.tier,
            models: options.models ?? {},
            quota_groups: options.quotaGroups,
          }
        : undefined,
    created_at: 1,
    last_used: options.lastUsed ?? 1,
    is_active: options.active,
  };
}

describe('account tier filtering', () => {
  it('normalizes tier keys while keeping restricted tiers separate', () => {
    expect(getAccountTierKey(createAccount('pro-a', { tier: ' Pro ' }))).toBe('pro');
    expect(getAccountTierKey(createAccount('pro-b', { tier: 'pro' }))).toBe('pro');
    expect(getAccountTierKey(createAccount('restricted', { tier: 'Pro (Restricted)' }))).toBe(
      'pro (restricted)',
    );
    expect(getAccountTierKey(createAccount('unknown'))).toBe(ACCOUNT_TIER_UNKNOWN_KEY);
  });

  it('builds dynamic tier options with stable counts and unknown as an explicit option', () => {
    const options = buildAccountTierOptions([
      createAccount('free', { tier: 'Free' }),
      createAccount('pro-a', { tier: 'Pro' }),
      createAccount('pro-b', { tier: ' pro ' }),
      createAccount('unknown'),
    ]);

    expect(options).toEqual([
      { key: 'free', label: 'Free', count: 1 },
      { key: 'pro', label: 'Pro', count: 2 },
      { key: ACCOUNT_TIER_UNKNOWN_KEY, label: 'Unknown', count: 1 },
    ]);
  });

  it('strictly filters before pinning matching active accounts', () => {
    const accounts = [
      createAccount('free-active', { tier: 'Free', active: true, lastUsed: 10 }),
      createAccount('pro-inactive', { tier: 'Pro', lastUsed: 5 }),
      createAccount('ultra-active', { tier: 'Ultra', active: true, lastUsed: 2 }),
    ];

    const result = filterAndSortCloudAccounts(accounts, {
      selectedTierKeys: ['pro', 'ultra'],
      sortKey: 'recently-used',
      modelVisibility: {},
    });

    expect(result.map((account) => account.id)).toEqual(['ultra-active', 'pro-inactive']);
  });

  it('ignores stale selected tier keys when filtering', () => {
    const accounts = [
      createAccount('free', { tier: 'Free' }),
      createAccount('pro', { tier: 'Pro' }),
    ];

    const result = filterAndSortCloudAccounts(accounts, {
      selectedTierKeys: ['pro', 'stale-tier'],
      sortKey: 'recently-used',
      modelVisibility: {},
    });

    expect(result.map((account) => account.id)).toEqual(['pro']);
  });

  it('sorts quota by highest visible matching model quota first', () => {
    const accounts = [
      createAccount('hidden-high', {
        tier: 'Pro',
        models: {
          'claude-3-7-sonnet': { percentage: 5, resetTime: '' },
          'gemini-3-flash': { percentage: 100, resetTime: '', display_name: 'Gemini 3 Flash' },
        },
      }),
      createAccount('visible-high', {
        tier: 'Pro',
        models: {
          'claude-3-7-sonnet': { percentage: 70, resetTime: '' },
          'gemini-3-flash': { percentage: 10, resetTime: '', display_name: 'Gemini 3 Flash' },
        },
      }),
      createAccount('visible-highest', {
        tier: 'Pro',
        models: {
          'claude-3-7-sonnet': { percentage: 95, resetTime: '' },
        },
      }),
      createAccount('only-hidden-quota', {
        tier: 'Pro',
        models: {
          'gemini-3-flash': { percentage: 100, resetTime: '', display_name: 'Gemini 3 Flash' },
        },
      }),
    ];

    const result = filterAndSortCloudAccounts(accounts, {
      selectedTierKeys: ['pro'],
      sortKey: 'quota-claude',
      modelVisibility: {
        'claude-3-7-sonnet': true,
        'gemini-3-flash': false,
      },
    });

    expect(result.map((account) => account.id)).toEqual([
      'visible-highest',
      'visible-high',
      'hidden-high',
      'only-hidden-quota',
    ]);
  });

  it('uses Claude and GPT grouped quota as a lower bound for Claude quota sorting', () => {
    const accounts = [
      createAccount('model-high-group-low', {
        tier: 'Pro',
        models: {
          'claude-sonnet-4-5': { percentage: 90, resetTime: '' },
        },
        quotaGroups: [
          {
            display_name: 'Claude and GPT models',
            buckets: [
              {
                bucket_id: '3p-5h',
                window: '5h',
                remaining_fraction: 0.02,
                reset_time: '',
              },
            ],
          },
        ],
      }),
      createAccount('model-medium-group-healthy', {
        tier: 'Pro',
        models: {
          'claude-sonnet-4-5': { percentage: 45, resetTime: '' },
        },
        quotaGroups: [
          {
            display_name: 'Claude and GPT models',
            buckets: [
              {
                bucket_id: '3p-5h',
                window: '5h',
                remaining_fraction: 0.8,
                reset_time: '',
              },
            ],
          },
        ],
      }),
    ];

    const result = filterAndSortCloudAccounts(accounts, {
      selectedTierKeys: ['pro'],
      sortKey: 'quota-claude',
      modelVisibility: {},
    });

    expect(result.map((account) => account.id)).toEqual([
      'model-medium-group-healthy',
      'model-high-group-low',
    ]);
  });

  it('formats tier labels without inventing provider values', () => {
    expect(formatAccountTierLabel('  Pro   (Restricted) ')).toBe('Pro (Restricted)');
    expect(formatAccountTierLabel(undefined)).toBe('Unknown');
  });
});
