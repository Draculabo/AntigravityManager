import { describe, expect, it, vi } from 'vitest';
import type { CloudQuotaData, CloudQuotaGroup } from '@/modules/cloud-account/types';
import { buildAccountLeaseQuotaSnapshot } from '@/server/gateway/modules/account-lease/policies/account-lease-quota.policy';
import { AccountLeaseQuotaRefreshPolicy } from '@/server/gateway/modules/account-lease/policies/account-lease-quota-refresh.policy';
import type { AccountLeaseTokenData } from '@/server/gateway/modules/account-lease/interfaces/account-lease-token-types';
import { RateLimitReason } from '@/server/gateway/shared/services/rate-limit-tracker.service';
import {
  mergeQuotaWindows,
  quotaWindowWaitSeconds,
} from '@/modules/cloud-account/utils/quota-windows';
import { selectWeeklyQuotaItems } from '@/modules/cloud-account/utils/quota-groups';

const model = 'claude-sonnet-4-6';
const short = '2090-01-01T01:00:00Z';
const long = '2090-01-04T00:00:00Z';
function group(fiveHour: number, weekly?: number, name = 'Claude and GPT models'): CloudQuotaGroup {
  return {
    display_name: name,
    buckets: [
      { bucket_id: '3p-5h', window: '5h', remaining_fraction: fiveHour, reset_time: short },
      ...(weekly === undefined
        ? []
        : [
            {
              bucket_id: '3p-week',
              window: 'weekly',
              remaining_fraction: weekly,
              reset_time: long,
            },
          ]),
    ],
  };
}
function quota(groups: CloudQuotaGroup[]): CloudQuotaData {
  return { models: { [model]: { percentage: 90, resetTime: short } }, quota_groups: groups };
}
function fixture(previous: CloudQuotaData, next: CloudQuotaData) {
  const snapshot = buildAccountLeaseQuotaSnapshot(previous);
  const token: AccountLeaseTokenData = {
    account_id: 'window-account',
    email: 'window@example.test',
    access_token: 'synthetic-access',
    refresh_token: 'synthetic-refresh',
    token_type: 'Bearer',
    expires_in: 3600,
    expiry_timestamp: 4102444800,
    quota: previous,
    model_quotas: snapshot.modelQuotas,
    model_limits: {},
    model_reset_times: snapshot.modelResetTimes,
    model_forwarding_rules: {},
  };
  const cache = new Map([[token.account_id, token]]);
  const updateQuota = vi.fn();
  const clear = vi.fn();
  const lock = vi.fn(() => true);
  const policy = new AccountLeaseQuotaRefreshPolicy({
    accountStore: {
      getAccounts: vi.fn(),
      getAccount: vi.fn(),
      async compareAndUpdateToken(id, _expected, token, guard) {
        await this.updateToken(id, token, guard);
        return true;
      },
      updateToken: vi.fn(),
      updateQuota,
      mutateHealth: vi.fn(),
    },
    upstream: {
      fetchQuota: vi.fn(async () => next),
      refreshAccessToken: vi.fn(),
      fetchProjectId: vi.fn(),
      normalizeRefreshedOAuthClientKey: vi.fn(),
    },
    getTokenCache: () => cache,
    setLockoutUntilIso: lock,
    clearRecoveredQuotaLocks: clear,
    logger: { warn: vi.fn() },
  });
  return { policy, cache, updateQuota, clear, lock };
}

describe('independent quota window protection', () => {
  it('uses numeric instants and only exhausted windows for route waiting', () => {
    const source = quota([group(0, 0.7)]);
    expect(quotaWindowWaitSeconds(source, model, Date.parse(short) - 1000)).toBe(1);
    expect(quotaWindowWaitSeconds(source, model, Date.parse(short))).toBe(0);
    expect(quotaWindowWaitSeconds(source, 'gemini-3-flash', 0)).toBe(0);
  });
  it('keeps omitted active windows but does not manufacture an expired cycle', () => {
    const previous = quota([group(0.8, 0)]);
    const next = { models: previous.models };
    expect(mergeQuotaWindows(previous, next, Date.parse(short) + 1).quota_groups).toEqual([
      { ...group(0.8, 0), buckets: [group(0.8, 0).buckets[1]] },
    ]);
    expect(mergeQuotaWindows(previous, next, Date.parse(long)).quota_groups).toEqual([
      { ...group(0.8, 0), buckets: [group(0.8, 0).buckets[1]] },
    ]);
  });
  it('uses the same seven-day window identity in the existing weekly display', () => {
    const source = group(0.8, 0.001);
    source.buckets[1].window = '7d';
    source.buckets[1].bucket_id = 'official-7d';
    expect(selectWeeklyQuotaItems([source]).map((item) => item.bucket)).toEqual([
      source.buckets[1],
    ]);
    expect(buildAccountLeaseQuotaSnapshot(quota([source])).modelQuotas[model]).toBe(0);
  });
  it('uses the last exhausted reset without changing either source window', () => {
    const source = quota([group(0, 0)]);
    const before = structuredClone(source);
    const snapshot = buildAccountLeaseQuotaSnapshot(source);
    expect({
      percentage: snapshot.modelQuotas[model],
      reset: snapshot.modelResetTimes[model],
    }).toEqual({ percentage: 0, reset: long });
    expect(source).toEqual(before);
  });
  it.each([0.0011, 0.004])(
    'keeps a positive weekly raw fraction %s usable despite rounded display zero',
    (fraction) => {
      expect(
        buildAccountLeaseQuotaSnapshot(quota([group(0.8, fraction)])).modelQuotas[model],
      ).toBeCloseTo(fraction * 100);
    },
  );
  it('applies the agreed weekly near-zero threshold', () => {
    expect(buildAccountLeaseQuotaSnapshot(quota([group(0.8, 0.001)])).modelQuotas[model]).toBe(0);
  });
  it('does not borrow an unrelated Claude group minimum', () => {
    const source = quota([group(0, 0, 'Claude Opus'), group(0.8, 0.5, 'Claude Sonnet')]);
    expect(buildAccountLeaseQuotaSnapshot(source).modelQuotas[model]).toBe(50);
  });
  it('does not make a non-exhausted weekly reset the blocking deadline', () => {
    expect(buildAccountLeaseQuotaSnapshot(quota([group(0, 0.7)])).modelResetTimes[model]).toBe(
      short,
    );
  });
  it('retains a missing weekly window during a partial realtime refresh', async () => {
    const previous = quota([group(0, 0)]);
    const { policy, cache, clear, lock, updateQuota } = fixture(previous, quota([group(0.8)]));
    expect(
      await policy.refreshRealtimeQuotaAndReconcileLimit(
        'window-account',
        RateLimitReason.QuotaExhausted,
        model,
      ),
    ).toBe('locked');
    expect(cache.get('window-account')?.quota?.quota_groups).toEqual([group(0.8, 0)]);
    expect(updateQuota).toHaveBeenCalledWith(
      'window-account',
      quota([group(0.8, 0)]),
      expect.any(Function),
    );
    expect(clear).not.toHaveBeenCalled();
    expect(lock).toHaveBeenCalledWith(
      'window-account',
      long,
      RateLimitReason.QuotaExhausted,
      model,
    );
  });
  it('recovers only after both previously observed windows report fresh positive values', async () => {
    const { policy, cache, clear, lock } = fixture(quota([group(0, 0)]), quota([group(0.8, 0.5)]));
    expect(
      await policy.refreshRealtimeQuotaAndReconcileLimit(
        'window-account',
        RateLimitReason.QuotaExhausted,
        model,
      ),
    ).toBe('recovered');
    expect(cache.get('window-account')?.quota).toEqual(quota([group(0.8, 0.5)]));
    expect(clear).toHaveBeenCalledWith('window-account', [model], true);
    expect(lock).not.toHaveBeenCalled();
  });
});
