import { describe, expect, it, vi } from 'vitest';
import { AccountLeaseFulfillmentPolicy } from '@/modules/proxy-gateway/server/modules/account-lease/policies/account-lease-fulfillment-policy';
import type { AccountLeaseHydrationPolicy } from '@/modules/proxy-gateway/server/modules/account-lease/policies/account-lease-hydration-policy';
import type { AccountLeaseTokenData } from '@/modules/proxy-gateway/server/modules/account-lease/interfaces/account-lease-token-types';

function createToken(overrides: Partial<AccountLeaseTokenData> = {}): AccountLeaseTokenData {
  return {
    account_id: 'acc-1',
    email: 'lease@example.com',
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    id_token: 'id-token',
    oauth_client_key: 'custom-client',
    token_type: 'Bearer',
    expires_in: 3600,
    expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
    project_id: undefined,
    session_id: 'session-1',
    upstream_proxy_url: 'http://127.0.0.1:8080',
    model_quotas: {},
    model_limits: {},
    model_reset_times: {},
    model_forwarding_rules: {},
    ...overrides,
  };
}

describe('AccountLeaseFulfillmentPolicy', () => {
  it('hydrates the selected token, records success, binds session, and returns a cloud account lease', async () => {
    const hydrationPolicy = {
      hydrateSelectedToken: vi.fn().mockResolvedValue('resolved-project'),
    } as unknown as AccountLeaseHydrationPolicy;
    const markRateLimitSuccess = vi.fn();
    const bindSession = vi.fn();
    const logger = {
      error: vi.fn(),
    };
    const policy = new AccountLeaseFulfillmentPolicy({
      hydrationPolicy,
      markRateLimitSuccess,
      bindSession,
      stickySessionTtlMs: 600_000,
      resolveFallbackProjectId: () => 'fallback-project',
      logger,
    });

    const lease = await policy.finalizeSelectedToken({
      accountId: 'acc-1',
      tokenData: createToken(),
      nowSeconds: 100,
      sessionKey: 'openai:user-1',
    });

    expect(hydrationPolicy.hydrateSelectedToken).toHaveBeenCalledWith({
      accountId: 'acc-1',
      tokenData: expect.objectContaining({
        access_token: 'access-token',
      }),
      nowSeconds: 100,
      fallbackProjectId: 'fallback-project',
    });
    expect(markRateLimitSuccess).toHaveBeenCalledWith('acc-1');
    expect(bindSession).toHaveBeenCalledWith('openai:user-1', 'acc-1', expect.any(Number));
    expect(lease).toEqual(
      expect.objectContaining({
        id: 'acc-1',
        provider: 'google',
        email: 'lease@example.com',
        token: expect.objectContaining({
          access_token: 'access-token',
          project_id: 'resolved-project',
          session_id: 'session-1',
        }),
      }),
    );
  });

  it('returns null and logs when fulfillment fails', async () => {
    const hydrationPolicy = {
      hydrateSelectedToken: vi.fn().mockRejectedValue(new Error('hydrate failed')),
    } as unknown as AccountLeaseHydrationPolicy;
    const logger = {
      error: vi.fn(),
    };
    const policy = new AccountLeaseFulfillmentPolicy({
      hydrationPolicy,
      markRateLimitSuccess: vi.fn(),
      bindSession: vi.fn(),
      stickySessionTtlMs: 600_000,
      resolveFallbackProjectId: () => 'fallback-project',
      logger,
    });

    await expect(
      policy.finalizeSelectedToken({
        accountId: 'acc-1',
        tokenData: createToken(),
        nowSeconds: 100,
      }),
    ).resolves.toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to finalize selected account token',
      expect.any(Error),
    );
  });
});
