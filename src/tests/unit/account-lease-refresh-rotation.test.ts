import { describe, expect, it, vi } from 'vitest';

import { OAuthTokenRefreshError } from '@/modules/cloud-account/services/GoogleAPIService';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import type {
  AccountLeaseAccountStore,
  AccountLeaseUpstream,
} from '@/modules/proxy-gateway/server/modules/account-lease/interfaces/account-lease-adapters';

function createAccount(id: string, expiryTimestamp: number): CloudAccount {
  return {
    id,
    provider: 'google',
    email: `${id}@example.com`,
    token: {
      access_token: `access-${id}`,
      refresh_token: `refresh-${id}`,
      expires_in: 3600,
      expiry_timestamp: expiryTimestamp,
      token_type: 'Bearer',
      project_id: `project-${id}`,
    },
    created_at: 1,
    last_used: 1,
  };
}

function createService(refreshAccessToken: AccountLeaseUpstream['refreshAccessToken']): {
  service: AccountLeaseService;
  refreshAccessToken: ReturnType<typeof vi.fn>;
} {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const accounts = [createAccount('acc-1', nowSeconds), createAccount('acc-2', nowSeconds + 3600)];
  const accountStore: AccountLeaseAccountStore = {
    getAccounts: vi.fn(async () => structuredClone(accounts)),
    getAccount: vi.fn(async (accountId) =>
      structuredClone(accounts.find((account) => account.id === accountId)),
    ),
    updateToken: vi.fn(),
    compareAndUpdateToken: vi.fn().mockResolvedValue(true),
    updateQuota: vi.fn(),
    mutateHealth: vi.fn(),
  };
  const refresh = vi.fn(refreshAccessToken);
  const upstream: AccountLeaseUpstream = {
    fetchQuota: vi.fn(),
    refreshAccessToken: refresh,
    fetchProjectId: vi.fn(),
    normalizeRefreshedOAuthClientKey: vi.fn(),
  };
  return { service: new AccountLeaseService(accountStore, upstream), refreshAccessToken: refresh };
}

describe('AccountLeaseService refresh rejection rotation', () => {
  it('passes a synchronized first-strike snapshot into the next lease refresh', async () => {
    const { service, refreshAccessToken } = createService(async () => ({
      access_token: 'refreshed',
      expires_in: 3600,
      token_type: 'Bearer',
    }));
    await service.loadAccounts();
    const oauthHealth = {
      refresh_blocked: false,
      invalid_grant_count: 1,
      invalid_grant_last_at_ms: 1,
      reason: 'invalid_grant' as const,
    };

    expect(service.updateAccountOAuthHealth('acc-1', oauthHealth)).toBe(true);
    await expect(service.getNextToken()).resolves.toMatchObject({ id: 'acc-1' });
    expect(refreshAccessToken).toHaveBeenCalledWith(
      'acc-1',
      'refresh-acc-1',
      undefined,
      undefined,
      { oauth: oauthHealth },
    );
  });

  it('removes an externally blocked account from the running lease cache', async () => {
    const { service, refreshAccessToken } = createService(async () => ({
      access_token: 'unused',
      expires_in: 3600,
      token_type: 'Bearer',
    }));
    await service.loadAccounts();

    expect(service.evictAccount('acc-1')).toBe(true);
    await expect(service.getNextToken()).resolves.toMatchObject({ id: 'acc-2' });
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it('rotates only after the typed invalid_grant refresh rejection', async () => {
    const { service, refreshAccessToken } = createService(async () => {
      throw new OAuthTokenRefreshError('invalid_grant', 400, 'default');
    });
    await service.loadAccounts();

    await expect(service.getNextToken()).resolves.toMatchObject({ id: 'acc-2' });
    expect(refreshAccessToken).toHaveBeenCalledOnce();
  });

  it('does not rotate when hydration fails for an unrelated reason', async () => {
    const { service, refreshAccessToken } = createService(async () => {
      throw new Error('storage unavailable');
    });
    await service.loadAccounts();

    await expect(service.getNextToken()).resolves.toBeNull();
    expect(refreshAccessToken).toHaveBeenCalledOnce();
  });
});
