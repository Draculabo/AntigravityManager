import { describe, expect, it, vi } from 'vitest';
import { AccountLeaseTokenCache } from '@/modules/proxy-gateway/server/modules/account-lease/stores/account-lease-token-cache';
import type { AccountLeaseAccountStore } from '@/modules/proxy-gateway/server/modules/account-lease/interfaces/account-lease-adapters';
import type { AccountLeaseTokenData } from '@/modules/proxy-gateway/server/modules/account-lease/interfaces/account-lease-token-types';
import type { CloudAccount } from '@/modules/cloud-account/types';

function createAccount(overrides: Partial<CloudAccount> = {}): CloudAccount {
  return {
    id: 'acc-1',
    provider: 'google',
    email: 'lease@example.com',
    token: {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      oauth_client_key: ' CUSTOM-CLIENT ',
      token_type: '',
      expires_in: 3600,
      expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
    },
    quota: {
      models: {
        'models/gemini-3-pro': {
          percentage: 50,
          resetTime: '2026-06-20T00:00:00.000Z',
          max_output_tokens: 8192,
        },
      },
      model_forwarding_rules: {
        'models/gemini-old': 'models/gemini-new',
      },
    },
    proxy_url: 'http://127.0.0.1:8080',
    created_at: 1,
    last_used: 1,
    ...overrides,
  };
}

function createStore(accounts: CloudAccount[]): AccountLeaseAccountStore {
  return {
    getAccounts: vi.fn().mockResolvedValue(accounts),
    getAccount: vi.fn(),
    updateToken: vi.fn(),
    updateQuota: vi.fn(),
  };
}

function createTokenCache(store: AccountLeaseAccountStore) {
  const tokenCache = new Map<string, AccountLeaseTokenData>();
  const applyQuotaSnapshot = vi.fn();
  const logger = {
    error: vi.fn(),
    log: vi.fn(),
  };
  const cache = new AccountLeaseTokenCache({
    accountStore: store,
    getTokenCache: () => tokenCache,
    applyQuotaSnapshot,
    logger,
  });

  return {
    applyQuotaSnapshot,
    cache,
    logger,
    tokenCache,
  };
}

describe('AccountLeaseTokenCache', () => {
  it('loads cloud accounts into normalized account lease token state', async () => {
    const store = createStore([createAccount()]);
    const { applyQuotaSnapshot, cache, tokenCache } = createTokenCache(store);

    const count = await cache.loadAccounts();

    expect(count).toBe(1);
    expect(tokenCache.get('acc-1')).toEqual(
      expect.objectContaining({
        account_id: 'acc-1',
        email: 'lease@example.com',
        oauth_client_key: 'custom-client',
        token_type: 'Bearer',
        upstream_proxy_url: 'http://127.0.0.1:8080',
        model_quotas: {
          'gemini-3-pro': 50,
        },
        model_limits: {
          'gemini-3-pro': 8192,
        },
        model_forwarding_rules: {
          'gemini-old': 'gemini-new',
        },
      }),
    );
    expect(tokenCache.get('acc-1')?.session_id).toMatch(/^-\d+$/);
    expect(applyQuotaSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        modelForwardingRules: {
          'gemini-old': 'gemini-new',
        },
      }),
    );
  });

  it('returns zero and logs when account storage loading fails', async () => {
    const store = createStore([]);
    vi.mocked(store.getAccounts).mockRejectedValue(new Error('storage failed'));
    const { cache, logger } = createTokenCache(store);

    await expect(cache.loadAccounts()).resolves.toBe(0);
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to load cloud accounts into token cache',
      expect.any(Error),
    );
  });

  it('rethrows account storage failures through the strict reload boundary', async () => {
    const store = createStore([]);
    vi.mocked(store.getAccounts).mockRejectedValue(new Error('storage failed'));
    const { cache, logger } = createTokenCache(store);

    await expect(cache.loadAccountsOrThrow()).rejects.toThrow('storage failed');
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to load cloud accounts into token cache',
      expect.any(Error),
    );
  });
});
