import { describe, expect, it, vi } from 'vitest';

import type { CloudAccount } from '@/modules/cloud-account/types';
import type {
  AccountLeaseAccountStore,
  AccountLeaseUpstream,
} from '@/modules/proxy-gateway/server/modules/account-lease/interfaces/account-lease-adapters';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/modules/account-lease/account-lease.service';

function createAccount(id: string): CloudAccount {
  return {
    id,
    provider: 'google',
    email: `${id}@example.com`,
    token: {
      access_token: `access-${id}`,
      refresh_token: `refresh-${id}`,
      expires_in: 3600,
      expiry_timestamp: 4_102_444_800,
      token_type: 'Bearer',
      project_id: 'project-a',
    },
    created_at: 1,
    last_used: 1,
  };
}

describe('AccountLeaseService pool Retry-After', () => {
  it('reports the shortest current model wait across eligible accounts', async () => {
    const accounts = [createAccount('acc-slow'), createAccount('acc-fast')];
    const accountStore: AccountLeaseAccountStore = {
      getAccounts: vi.fn(async () => structuredClone(accounts)),
      getAccount: vi.fn(async (id) =>
        structuredClone(accounts.find((account) => account.id === id)),
      ),
      updateToken: vi.fn(),
      updateQuota: vi.fn(),
      mutateHealth: vi.fn(async () => undefined),
    };
    const upstream: AccountLeaseUpstream = {
      fetchQuota: vi.fn(),
      refreshAccessToken: vi.fn(),
      fetchProjectId: vi.fn(),
      normalizeRefreshedOAuthClientKey: vi.fn(),
    };
    const service = new AccountLeaseService(accountStore, upstream);
    await service.loadAccounts();
    await service.markFromUpstreamError({
      accountIdOrEmail: 'acc-slow',
      status: 429,
      retryAfter: '30',
      body: 'rate_limit_exceeded',
      model: 'gemini-3-flash',
    });
    await service.markFromUpstreamError({
      accountIdOrEmail: 'acc-fast',
      status: 429,
      retryAfter: '12',
      body: 'rate_limit_exceeded',
      model: 'gemini-3-flash',
    });

    expect(service.getMinimumRateLimitWaitForPool({ model: 'gemini-3-flash' })).toBe(12);
  });
});
