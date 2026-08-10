import { describe, expect, it, vi } from 'vitest';
import type {
  AccountLeaseAccountStore,
  AccountLeaseUpstream,
} from '@/modules/proxy-gateway/server/modules/account-lease/interfaces/account-lease-adapters';
import { AccountLeaseQuotaRefreshPolicy } from '@/modules/proxy-gateway/server/modules/account-lease/policies/account-lease-quota-refresh.policy';
import type { AccountLeaseTokenData } from '@/modules/proxy-gateway/server/modules/account-lease/interfaces/account-lease-token-types';
import { RateLimitReason } from '@/modules/proxy-gateway/server/shared/services/rate-limit-tracker.service';

function createToken(overrides: Partial<AccountLeaseTokenData> = {}): AccountLeaseTokenData {
  return {
    account_id: 'acc-1',
    email: 'lease@example.com',
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    token_type: 'Bearer',
    expires_in: 3600,
    expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
    model_quotas: {},
    model_limits: {},
    model_reset_times: {},
    model_forwarding_rules: {},
    ...overrides,
  };
}

function createPolicy(tokenCache: Map<string, AccountLeaseTokenData>) {
  const accountStore: AccountLeaseAccountStore = {
    getAccounts: vi.fn(),
    getAccount: vi.fn(),
    updateToken: vi.fn(),
    updateQuota: vi.fn(),
  };
  const upstream: AccountLeaseUpstream = {
    fetchQuota: vi.fn(),
    refreshAccessToken: vi.fn(),
    fetchProjectId: vi.fn(),
    normalizeRefreshedOAuthClientKey: vi.fn(),
  };
  const setLockoutUntilIso = vi.fn().mockReturnValue(true);
  const clearRecoveredQuotaLocks = vi.fn();
  const logger = {
    warn: vi.fn(),
  };
  const policy = new AccountLeaseQuotaRefreshPolicy({
    accountStore,
    upstream,
    getTokenCache: () => tokenCache,
    setLockoutUntilIso,
    clearRecoveredQuotaLocks,
    logger,
  });

  return {
    accountStore,
    clearRecoveredQuotaLocks,
    logger,
    policy,
    setLockoutUntilIso,
    upstream,
  };
}

describe('AccountLeaseQuotaRefreshPolicy', () => {
  it('sets precise lockout from cached quota reset times', () => {
    const tokenCache = new Map([
      [
        'acc-1',
        createToken({
          model_reset_times: {
            'gemini-2.5-flash': '2026-06-20T08:00:00.000Z',
          },
        }),
      ],
    ]);
    const { policy, setLockoutUntilIso } = createPolicy(tokenCache);

    expect(
      policy.setPreciseLockoutFromCachedQuota(
        'acc-1',
        RateLimitReason.QuotaExhausted,
        'gemini-2.5-flash',
      ),
    ).toBe(true);
    expect(setLockoutUntilIso).toHaveBeenCalledWith(
      'acc-1',
      '2026-06-20T08:00:00.000Z',
      RateLimitReason.QuotaExhausted,
      'gemini-2.5-flash',
    );
  });

  it('clears the recovered model lock without applying a new lockout', async () => {
    const token = createToken({
      upstream_proxy_url: 'http://127.0.0.1:8080',
    });
    const tokenCache = new Map([['acc-1', token]]);
    const { accountStore, clearRecoveredQuotaLocks, policy, setLockoutUntilIso, upstream } =
      createPolicy(tokenCache);
    const quota = {
      models: {
        'models/gemini-2.5-flash': {
          percentage: 12,
          resetTime: '2026-06-20T08:30:00.000Z',
          max_output_tokens: 4096,
        },
      },
    };

    vi.mocked(upstream.fetchQuota).mockResolvedValue(quota);

    await expect(
      policy.refreshRealtimeQuotaAndReconcileLimit(
        'acc-1',
        RateLimitReason.QuotaExhausted,
        'gemini-2.5-flash',
      ),
    ).resolves.toBe('recovered');

    expect(upstream.fetchQuota).toHaveBeenCalledWith('access-token', 'http://127.0.0.1:8080');
    expect(accountStore.updateQuota).toHaveBeenCalledWith('acc-1', quota);
    expect(tokenCache.get('acc-1')).toEqual(
      expect.objectContaining({
        model_quotas: {
          'gemini-2.5-flash': 12,
        },
        model_limits: {
          'gemini-2.5-flash': 4096,
        },
      }),
    );
    expect(clearRecoveredQuotaLocks).toHaveBeenCalledWith('acc-1', ['gemini-2.5-flash'], true);
    expect(setLockoutUntilIso).not.toHaveBeenCalled();
  });

  it('keeps a zero-percent model locked using its own reset time', async () => {
    const tokenCache = new Map([['acc-1', createToken()]]);
    const { clearRecoveredQuotaLocks, policy, setLockoutUntilIso, upstream } =
      createPolicy(tokenCache);
    vi.mocked(upstream.fetchQuota).mockResolvedValue({
      models: {
        'models/gemini-2.5-flash': {
          percentage: 0,
          resetTime: '2026-06-20T08:30:00.000Z',
        },
        'models/gemini-3.1-pro-high': {
          percentage: 30,
          resetTime: '2026-06-20T08:00:00.000Z',
        },
      },
    });

    await expect(
      policy.refreshRealtimeQuotaAndReconcileLimit(
        'acc-1',
        RateLimitReason.QuotaExhausted,
        'gemini-2.5-flash',
      ),
    ).resolves.toBe('locked');

    expect(clearRecoveredQuotaLocks).toHaveBeenCalledWith('acc-1', ['gemini-3.1-pro-high'], false);
    expect(setLockoutUntilIso).toHaveBeenCalledWith(
      'acc-1',
      '2026-06-20T08:30:00.000Z',
      RateLimitReason.QuotaExhausted,
      'gemini-2.5-flash',
    );
  });

  it('treats a recovered canonical model as recovery for its requested alias', async () => {
    const tokenCache = new Map([['acc-1', createToken()]]);
    const { clearRecoveredQuotaLocks, policy, setLockoutUntilIso, upstream } =
      createPolicy(tokenCache);
    vi.mocked(upstream.fetchQuota).mockResolvedValue({
      models: {
        'models/gemini-3.1-pro': {
          percentage: 18,
          resetTime: '2026-06-20T08:30:00.000Z',
        },
      },
    });

    await expect(
      policy.refreshRealtimeQuotaAndReconcileLimit(
        'acc-1',
        RateLimitReason.QuotaExhausted,
        'models/gemini-3.1-pro-high',
      ),
    ).resolves.toBe('recovered');

    expect(clearRecoveredQuotaLocks).toHaveBeenCalledWith(
      'acc-1',
      ['gemini-3.1-pro', 'gemini-3.1-pro-high'],
      true,
    );
    expect(setLockoutUntilIso).not.toHaveBeenCalled();
  });

  it('does not mutate cached quota or clear locks when persistence fails', async () => {
    const token = createToken({
      model_quotas: {
        'gemini-2.5-flash': 0,
      },
    });
    const tokenCache = new Map([['acc-1', token]]);
    const { accountStore, clearRecoveredQuotaLocks, logger, policy, upstream } =
      createPolicy(tokenCache);
    vi.mocked(upstream.fetchQuota).mockResolvedValue({
      models: {
        'models/gemini-2.5-flash': {
          percentage: 20,
          resetTime: '2026-06-20T08:30:00.000Z',
        },
      },
    });
    vi.mocked(accountStore.updateQuota).mockRejectedValue(new Error('write failed'));

    await expect(
      policy.refreshRealtimeQuotaAndReconcileLimit(
        'acc-1',
        RateLimitReason.QuotaExhausted,
        'gemini-2.5-flash',
      ),
    ).resolves.toBe('unavailable');

    expect(tokenCache.get('acc-1')).toBe(token);
    expect(tokenCache.get('acc-1')?.model_quotas).toEqual({
      'gemini-2.5-flash': 0,
    });
    expect(clearRecoveredQuotaLocks).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('does not clear locks when realtime quota fetching fails', async () => {
    const token = createToken({
      model_quotas: {
        'gemini-2.5-flash': 0,
      },
    });
    const tokenCache = new Map([['acc-1', token]]);
    const { accountStore, clearRecoveredQuotaLocks, logger, policy, upstream } =
      createPolicy(tokenCache);
    vi.mocked(upstream.fetchQuota).mockRejectedValue(new Error('network unavailable'));

    await expect(
      policy.refreshRealtimeQuotaAndReconcileLimit(
        'acc-1',
        RateLimitReason.QuotaExhausted,
        'gemini-2.5-flash',
      ),
    ).resolves.toBe('unavailable');

    expect(accountStore.updateQuota).not.toHaveBeenCalled();
    expect(tokenCache.get('acc-1')).toBe(token);
    expect(clearRecoveredQuotaLocks).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});
