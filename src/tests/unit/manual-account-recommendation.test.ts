import { describe, expect, it } from 'vitest';

import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import { getManualAccountRecommendations } from '@/modules/cloud-account/utils/manual-account-recommendation';

const RESET = '2026-11-26T06:00:00Z';
const ALL_CLIENTS = ['classic', 'ide', 'agy'];
type Quota = NonNullable<CloudAccountView['quota']>;

function quotaGroup(
  displayName: string,
  window: '5h' | 'weekly',
  percentage: number,
): NonNullable<Quota['quota_groups']>[number] {
  return {
    display_name: displayName,
    buckets: [
      {
        bucket_id: `${displayName}-${window}`,
        window,
        remaining_fraction: percentage / 100,
        reset_time: RESET,
      },
    ],
  };
}

function account(
  id: string,
  modelPercentages: Record<string, number>,
  options: {
    tier?: string;
    groups?: Quota['quota_groups'];
    state?: Partial<CloudAccountView>;
  } = {},
): CloudAccountView {
  return {
    id,
    provider: 'google',
    email: `${id}@example.test`,
    created_at: 1,
    last_used: 1,
    proxy_configured: false,
    status: 'active',
    quota: {
      models: Object.fromEntries(
        Object.entries(modelPercentages).map(([model, percentage]) => [
          model,
          { percentage, resetTime: RESET },
        ]),
      ),
      subscription_tier: options.tier,
      quota_groups: options.groups,
    },
    ...options.state,
  };
}

describe('manual account recommendations', () => {
  it('selects the highest-scoring distinct Gemini and Claude pair for each client', () => {
    const accounts = [
      account(
        'a',
        { 'gemini-3.1-pro': 95, 'claude-sonnet-4-6': 10 },
        {
          state: { is_active_classic: true },
        },
      ),
      account(
        'b',
        { 'gemini-3.1-pro': 80, 'claude-sonnet-4-6': 90 },
        {
          state: { is_active_ide: true },
        },
      ),
      account(
        'c',
        { 'gemini-3.1-pro': 70, 'claude-sonnet-4-6': 75 },
        {
          state: { is_active_agy: true },
        },
      ),
    ];

    expect(getManualAccountRecommendations(accounts)).toEqual(
      new Map([
        ['a', [{ family: 'gemini', fiveHourPercentage: 95, targets: ['ide', 'agy'] }]],
        ['b', [{ family: 'claude', fiveHourPercentage: 90, targets: ['classic', 'agy'] }]],
        [
          'c',
          [
            { family: 'gemini', fiveHourPercentage: 70, targets: ['classic'] },
            { family: 'claude', fiveHourPercentage: 75, targets: ['ide'] },
          ],
        ],
      ]),
    );
  });

  it('prioritizes paid accounts and grouped five-hour quota once the weekly guard passes', () => {
    const accounts = [
      account(
        'depleted',
        { 'gemini-3.1-pro': 100 },
        {
          tier: 'Ultra',
          groups: [quotaGroup('Gemini', 'weekly', 5)],
        },
      ),
      account(
        'free',
        { 'gemini-3.1-pro': 99 },
        {
          groups: [quotaGroup('Claude', '5h', 95)],
        },
      ),
      account(
        'paid',
        { 'gemini-3.8-flash': 35 },
        {
          tier: 'Pro',
          groups: [quotaGroup('Gemini', '5h', 20)],
        },
      ),
      account(
        'blocked',
        { 'gemini-3.1-pro': 100 },
        {
          tier: 'Ultra',
          state: {
            health: {
              validation: {
                status: 'requires_action',
                reason: 'VALIDATION_REQUIRED',
                has_verification_link: false,
              },
            },
          },
        },
      ),
    ];

    expect(getManualAccountRecommendations(accounts)).toEqual(
      new Map([['paid', [{ family: 'gemini', fiveHourPercentage: 20, targets: ALL_CLIENTS }]]]),
    );
  });

  it('uses Flash when Pro is absent and preserves an explicit zero Pro balance', () => {
    const accounts = [
      account('empty-pro', { 'gemini-3.1-pro': 0, 'gemini-3.8-flash': 100 }),
      account(
        'flash-only',
        { 'gemini-3.8-flash': 60 },
        {
          groups: [quotaGroup('Gemini 4 Argon', 'weekly', 0)],
        },
      ),
    ];

    expect(getManualAccountRecommendations(accounts)).toEqual(
      new Map([
        ['flash-only', [{ family: 'gemini', fiveHourPercentage: 60, targets: ALL_CLIENTS }]],
      ]),
    );
  });

  it('allows both model families to recommend the same account when it is the only candidate', () => {
    const accounts = [
      account(
        'only',
        { 'gemini-3.1-pro': 73, 'claude-sonnet-4-6': 42 },
        {
          state: { is_active_classic: true },
        },
      ),
    ];

    expect(getManualAccountRecommendations(accounts)).toEqual(
      new Map([
        [
          'only',
          [
            { family: 'gemini', fiveHourPercentage: 73, targets: ['ide', 'agy'] },
            { family: 'claude', fiveHourPercentage: 42, targets: ['ide', 'agy'] },
          ],
        ],
      ]),
    );
  });
});
