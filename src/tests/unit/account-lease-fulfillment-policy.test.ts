import { describe, expect, it, vi } from 'vitest';
import { AccountLeaseFulfillmentPolicy } from '@/modules/proxy-gateway/server/modules/account-lease/policies/account-lease-fulfillment.policy';
import type { AccountLeaseHydrationPolicy } from '@/modules/proxy-gateway/server/modules/account-lease/policies/account-lease-hydration.policy';
import { AccountLeaseRefreshRejectedError } from '@/modules/proxy-gateway/server/modules/account-lease/policies/account-lease-hydration.policy';
import type { AccountLeaseTokenData } from '@/modules/proxy-gateway/server/modules/account-lease/interfaces/account-lease-token-types';
import type { AccountLeaseAccountStore } from '@/modules/proxy-gateway/server/modules/account-lease/interfaces/account-lease-adapters';

function createAccountStore(): AccountLeaseAccountStore {
  return {
    getAccounts: vi.fn(),
    getAccount: vi.fn(async (id) => ({
      id,
      provider: 'google' as const,
      email: 'lease@example.com',
      created_at: 1,
      last_used: 1,
      token: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
        expiry_timestamp: 3600,
        token_type: 'Bearer',
      },
    })),
    updateToken: vi.fn(),
    compareAndUpdateToken: vi.fn().mockResolvedValue(true),
    updateQuota: vi.fn(),
    mutateHealth: vi.fn(),
  };
}

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
  it('hydrates the selected token, binds the session, and returns a cloud account lease', async () => {
    const hydrationPolicy = {
      hydrateSelectedToken: vi.fn().mockResolvedValue('resolved-project'),
    } as unknown as AccountLeaseHydrationPolicy;
    const bindSession = vi.fn();
    const logger = {
      error: vi.fn(),
    };
    const policy = new AccountLeaseFulfillmentPolicy({
      accountStore: createAccountStore(),
      isStillEligible: () => true,
      hydrationPolicy,
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

  it('throws and logs when fulfillment fails', async () => {
    const hydrationPolicy = {
      hydrateSelectedToken: vi.fn().mockRejectedValue(new Error('hydrate failed')),
    } as unknown as AccountLeaseHydrationPolicy;
    const logger = {
      error: vi.fn(),
    };
    const policy = new AccountLeaseFulfillmentPolicy({
      accountStore: createAccountStore(),
      isStillEligible: () => true,
      hydrationPolicy,
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
    ).rejects.toThrow('hydrate failed');
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to finalize selected account token',
      expect.any(Error),
    );
  });

  it('rethrows the typed refresh rejection for account rotation', async () => {
    const rejection = new AccountLeaseRefreshRejectedError('acc-1', 'invalid_grant');
    const hydrationPolicy = {
      hydrateSelectedToken: vi.fn().mockRejectedValue(rejection),
    } as unknown as AccountLeaseHydrationPolicy;
    const policy = new AccountLeaseFulfillmentPolicy({
      accountStore: createAccountStore(),
      isStillEligible: () => true,
      hydrationPolicy,
      bindSession: vi.fn(),
      stickySessionTtlMs: 600_000,
      resolveFallbackProjectId: () => 'fallback-project',
      logger: { error: vi.fn() },
    });

    await expect(
      policy.finalizeSelectedToken({
        accountId: 'acc-1',
        tokenData: createToken(),
        nowSeconds: 100,
      }),
    ).rejects.toBe(rejection);
  });

  it.each(['missing', 'ineligible'] as const)(
    'does not bind a session or issue a lease when the account is %s',
    async (state) => {
      const accountStore = createAccountStore();
      if (state === 'missing') {
        vi.mocked(accountStore.getAccount).mockResolvedValue(undefined);
      }
      const bindSession = vi.fn();
      const policy = new AccountLeaseFulfillmentPolicy({
        accountStore,
        isStillEligible: () => state !== 'ineligible',
        hydrationPolicy: {
          hydrateSelectedToken: vi.fn().mockResolvedValue('project'),
        } as unknown as AccountLeaseHydrationPolicy,
        bindSession,
        stickySessionTtlMs: 600_000,
        resolveFallbackProjectId: () => 'fallback',
        logger: { error: vi.fn() },
      });
      await expect(
        policy.finalizeSelectedToken({
          accountId: 'acc-1',
          tokenData: createToken(),
          nowSeconds: 100,
          sessionKey: 'session',
        }),
      ).resolves.toBeNull();
      expect(bindSession).not.toHaveBeenCalled();
    },
  );
});
