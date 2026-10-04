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
  it.each([
    ['claude-sonnet-4-6-thinking', 'claude-sonnet-4-6', 'Claude Sonnet 4.6 (Thinking)'],
    ['gemini-3.7-flash-high', 'gemini-3.7-flash-tiered', undefined],
  ])(
    'checks the actual account route for %s',
    async (requestedModel, physicalModel, displayName) => {
      const accounts = ['acc-slow', 'acc-fast'].map((id) => ({
        ...createAccount(id),
        quota: {
          models: {
            [physicalModel]: { percentage: 100, resetTime: '', display_name: displayName },
            'gemini-pro-agent': { percentage: 100, resetTime: '' },
          },
        },
      }));
      const accountStore: AccountLeaseAccountStore = {
        getAccounts: vi.fn(async () => structuredClone(accounts)),
        getAccount: vi.fn(async (id) =>
          structuredClone(accounts.find((account) => account.id === id)),
        ),
        updateToken: vi.fn(),
        updateQuota: vi.fn(),
        mutateHealth: vi.fn(async () => undefined),
      };
      const service = new AccountLeaseService(accountStore);
      await service.loadAccounts();
      expect(service.resolveDynamicModelForAccount('acc-slow', requestedModel)).toBe(physicalModel);
      for (const [accountId, delay] of [
        ['acc-slow', '520035'],
        ['acc-fast', '3600'],
      ]) {
        await service.markFromUpstreamError({
          accountIdOrEmail: accountId,
          status: 429,
          retryAfter: delay,
          body: 'QUOTA_EXHAUSTED',
          model: physicalModel,
        });
      }
      expect(service.getMinimumRateLimitWaitForPool({ model: requestedModel })).toBe(3600);
      await expect(service.getNextToken({ model: requestedModel })).resolves.toBeNull();
      await expect(service.getNextToken({ model: 'gemini-pro-agent' })).resolves.toMatchObject({
        provider: 'google',
      });
    },
  );

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

    const model = 'claude-sonnet-4-6-thinking';
    for (const [accountId, delay] of [
      ['acc-slow', '520035'],
      ['acc-fast', '3600'],
    ]) {
      await service.markFromUpstreamError({
        accountIdOrEmail: accountId,
        status: 429,
        retryAfter: delay,
        body: 'QUOTA_EXHAUSTED',
        model,
      });
    }
    expect(service.getMinimumRateLimitWaitForPool({ model })).toBe(3600);
    await expect(service.getNextToken({ model })).resolves.toBeNull();
    await expect(service.getNextToken({ model: 'gemini-pro-agent' })).resolves.toMatchObject({
      provider: 'google',
    });
    expect(upstream.fetchQuota).not.toHaveBeenCalled();
  });
});
