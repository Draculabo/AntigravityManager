import { describe, expect, it } from 'vitest';
import { buildAccountLeaseQuotaSnapshot } from '@/modules/proxy-gateway/server/modules/account-lease/policies/account-lease-quota-policy';

describe('account lease quota policy', () => {
  it('uses grouped Claude/GPT quota as a lower bound in quota snapshots', () => {
    const snapshot = buildAccountLeaseQuotaSnapshot({
      models: {
        'claude-sonnet-4-5': {
          percentage: 90,
          resetTime: '2026-05-05T00:00:00Z',
        },
      },
      quota_groups: [
        {
          display_name: 'Claude and GPT models',
          buckets: [
            {
              bucket_id: '3p-5h',
              window: '5h',
              remaining_fraction: 0.02,
              reset_time: '2026-05-05T05:00:00Z',
            },
          ],
        },
      ],
    });

    expect(snapshot.modelQuotas['claude-sonnet-4-5']).toBe(2);
    expect(snapshot.modelResetTimes['claude-sonnet-4-5']).toBe('2026-05-05T05:00:00Z');
  });

  it('normalizes forwarding rules and positive output limits', () => {
    const snapshot = buildAccountLeaseQuotaSnapshot({
      models: {
        'models/gemini-3-pro': {
          percentage: 50.8,
          resetTime: '2026-05-05T01:00:00Z',
          max_output_tokens: 8192.9,
        },
      },
      model_forwarding_rules: {
        'models/gemini-old': 'models/gemini-new',
      },
    });

    expect(snapshot.modelQuotas['gemini-3-pro']).toBe(50);
    expect(snapshot.modelLimits['gemini-3-pro']).toBe(8192);
    expect(snapshot.modelForwardingRules['gemini-old']).toBe('gemini-new');
  });
});
