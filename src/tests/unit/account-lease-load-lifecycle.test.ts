import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountLeaseTokenCache } from '@/server/gateway/modules/account-lease/stores/account-lease-token.store';
import { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import type { AccountLeaseTokenData } from '@/server/gateway/modules/account-lease/interfaces/account-lease-token-types';
import type {
  AccountLeaseAccountStore,
  AccountLeaseUpstream,
} from '@/server/gateway/modules/account-lease/interfaces/account-lease-adapters';
import type { CloudAccount } from '@/modules/cloud-account/types';
import {
  RateLimitReason,
  RateLimitTrackerService,
} from '@/server/gateway/shared/services/rate-limit-tracker.service';
import { ModelAvailabilityService } from '@/server/gateway/shared/services/model-availability.service';
import { createAccount } from './proxy-real-path.harness';

const services: AccountLeaseService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.onModuleDestroy();
  }
});
function fixture() {
  const accounts = [createAccount('load-a')];
  const store: AccountLeaseAccountStore = {
    getAccounts: vi.fn(async () => structuredClone(accounts)),
    getAccount: vi.fn(async (id) => structuredClone(accounts.find((account) => account.id === id))),
    async compareAndUpdateToken(id, _expected, token, guard) {
      await this.updateToken(id, token, guard);
      return true;
    },
    updateToken: vi.fn(),
    updateQuota: vi.fn(),
    mutateHealth: vi.fn(),
  };
  const upstream: AccountLeaseUpstream = {
    refreshAccessToken: vi.fn(),
    fetchQuota: vi.fn(),
    fetchProjectId: vi.fn(),
    normalizeRefreshedOAuthClientKey: vi.fn(),
  };
  const cache = new Map<string, AccountLeaseTokenData>();
  const applyQuotaSnapshot = vi.fn();
  const policy = new AccountLeaseTokenCache({
    accountStore: store,
    getTokenCache: () => cache,
    applyQuotaSnapshot,
    logger: { error: vi.fn(), log: vi.fn() },
  });
  const tracker = new RateLimitTrackerService();
  const availability = new ModelAvailabilityService();
  const lease = new AccountLeaseService(store, upstream, tracker, availability);
  services.push(lease);
  return {
    accounts,
    store,
    upstream,
    cache,
    policy,
    applyQuotaSnapshot,
    tracker,
    lease,
    availability,
  };
}

describe('account-cache load publication', () => {
  it('forgets deleted account state while retaining the other account and its quota protection', async () => {
    const { accounts, lease, tracker, availability } = fixture();
    accounts.push(createAccount('load-b'));
    await lease.loadAccounts();
    const selected = await lease.getNextToken({ sessionKey: 'deleted-session' });
    if (!selected) {
      throw new Error('Missing selected fixture account');
    }
    lease.commitSession(selected);
    lease.markAsForbidden('load-a');
    const reset = new Date(Date.now() + 3_600_000).toISOString();
    for (const id of ['load-a', 'load-b']) {
      tracker.setLockoutUntilIso(id, reset, RateLimitReason.QuotaExhausted, 'claude-sonnet');
      availability.mark(id, 'gemini-3-pro', 'model_forbidden');
    }
    const retained = availability.getSnapshot().filter((entry) => entry.accountId === 'load-b');
    accounts.splice(0, 1);
    lease.forgetDeletedAccount('load-a');
    expect(lease.getAccountCount()).toBe(1);
    expect(lease.isRateLimited('load-a', 'claude-sonnet')).toBe(false);
    expect(tracker.hasActiveQuotaLock('load-b', 'claude-sonnet')).toBe(true);
    expect(availability.getSnapshot()).toEqual(retained);
    expect((await lease.getNextToken({ sessionKey: 'deleted-session' }))?.id).toBe('load-b');
  });

  it('evicts the deleted account even when availability persistence fails', async () => {
    const { accounts, lease, tracker, availability } = fixture();
    accounts.push(createAccount('load-b'));
    await lease.loadAccounts();
    const failure = new Error('Synthetic availability cleanup failure');
    vi.spyOn(availability, 'clearAccountOrThrow').mockImplementationOnce(() => {
      throw failure;
    });
    tracker.setLockoutUntilIso(
      'load-b',
      new Date(Date.now() + 3_600_000).toISOString(),
      RateLimitReason.QuotaExhausted,
      'claude-sonnet',
    );
    expect(() => lease.forgetDeletedAccount('load-a')).toThrow(failure);
    expect(lease.getAccountCount()).toBe(1);
    expect((await lease.getNextToken())?.id).toBe('load-b');
    expect(tracker.hasActiveQuotaLock('load-b', 'claude-sonnet')).toBe(true);
    lease.forgetDeletedAccount('load-a');
    expect(lease.getAccountCount()).toBe(1);
  });

  it('does not re-create a fallback quota lock after deletion during a realtime probe', async () => {
    const { lease, upstream, tracker, store } = fixture();
    await lease.loadAccounts();
    const entered = Promise.withResolvers<void>();
    const probe = Promise.withResolvers<Awaited<ReturnType<AccountLeaseUpstream['fetchQuota']>>>();
    vi.mocked(upstream.fetchQuota).mockImplementation(() => {
      entered.resolve();
      return probe.promise;
    });
    const pending = lease.markFromUpstreamError({
      accountIdOrEmail: 'load-a',
      status: 429,
      model: 'claude-sonnet',
      body: 'quota exhausted',
    });
    await entered.promise;
    lease.forgetDeletedAccount('load-a');
    probe.reject(new Error('Synthetic late probe failure'));
    await pending;
    expect(lease.getAccountCount()).toBe(0);
    expect(tracker.isRateLimited('load-a', 'claude-sonnet')).toBe(false);
    expect(store.updateQuota).not.toHaveBeenCalled();
  });

  it('waits for the newest requested snapshot even when the old read finishes first', async () => {
    const { store, cache, policy } = fixture();
    await policy.loadAccounts();
    const old = Promise.withResolvers<CloudAccount[]>();
    const current = Promise.withResolvers<CloudAccount[]>();
    vi.mocked(store.getAccounts)
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    const first = policy.loadAccounts();
    const second = policy.loadAccounts();
    old.resolve([createAccount('obsolete')]);
    expect(await first).toBe(0);
    expect([...cache.keys()]).toEqual(['load-a']);
    current.resolve([createAccount('current')]);
    expect(await second).toBe(1);
    expect([...cache.keys()]).toEqual(['current']);
  });

  it('rejects a store snapshot after a same-valued live cache entry was replaced', async () => {
    const { store, cache, policy } = fixture();
    await policy.loadAccounts();
    const old = Promise.withResolvers<CloudAccount[]>();
    vi.mocked(store.getAccounts).mockReturnValueOnce(old.promise);
    const pending = policy.loadAccounts();
    const original = cache.get('load-a');
    if (!original) {
      throw new Error('Fixture entry missing');
    }
    const replacement = { ...original };
    cache.set('load-a', replacement);
    old.resolve([createAccount('load-a')]);
    expect(await pending).toBe(0);
    expect(cache.get('load-a')).toBe(replacement);
  });

  it('preserves a live OAuth block added while a storage read is pending', async () => {
    const { store, lease } = fixture();
    await lease.loadAccounts();
    const old = Promise.withResolvers<CloudAccount[]>();
    vi.mocked(store.getAccounts).mockReturnValueOnce(old.promise);
    const pending = lease.loadAccounts();
    expect(lease.updateAccountOAuthHealth('load-a', { refresh_blocked: true })).toBe(true);
    old.resolve([createAccount('load-a')]);
    expect(await pending).toBe(0);
    expect(await lease.getNextToken()).toBeNull();
  });

  it('allows a fresh stored snapshot after eviction without retaining an account tombstone', async () => {
    const { accounts, lease } = fixture();
    await lease.loadAccounts();
    expect(lease.evictAccount('load-a')).toBe(true);
    accounts[0].token.refresh_token = 'new-login-refresh';
    expect(await lease.loadAccounts()).toBe(1);
    expect((await lease.getNextToken())?.token.refresh_token).toBe('new-login-refresh');
  });

  it('does not let an obsolete conditional OAuth eviction cancel a current load', async () => {
    const { accounts, store, lease } = fixture();
    await lease.loadAccounts();
    const current = Promise.withResolvers<CloudAccount[]>();
    vi.mocked(store.getAccounts).mockReturnValueOnce(current.promise);
    const pending = lease.loadAccounts();
    expect(
      lease.evictAccount('load-a', { email: 'load-a@example.com', refreshToken: 'obsolete' }),
    ).toBe(false);
    accounts.splice(0, accounts.length, createAccount('load-current'));
    current.resolve(structuredClone(accounts));
    expect(await pending).toBe(1);
    expect((await lease.getNextToken())?.id).toBe('load-current');
  });

  it('does not let an older load overwrite a newer published snapshot or its forwarding', async () => {
    const { store, cache, policy, applyQuotaSnapshot } = fixture();
    const old = Promise.withResolvers<CloudAccount[]>();
    vi.mocked(store.getAccounts)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce([createAccount('load-new')]);
    const first = policy.loadAccounts();
    expect(await policy.loadAccounts()).toBe(1);
    old.resolve([createAccount('load-old')]);
    expect(await first).toBe(0);
    expect([...cache.keys()]).toEqual(['load-new']);
    expect(applyQuotaSnapshot).toHaveBeenCalledTimes(1);
  });

  it('keeps the published pool when a newer load fails and the old load later succeeds', async () => {
    const { store, cache, policy } = fixture();
    await policy.loadAccounts();
    const original = cache.get('load-a');
    const old = Promise.withResolvers<CloudAccount[]>();
    vi.mocked(store.getAccounts)
      .mockReturnValueOnce(old.promise)
      .mockRejectedValueOnce(new Error('synthetic store failure'));
    const first = policy.loadAccounts();
    expect(await policy.loadAccounts()).toBe(0);
    old.resolve([createAccount('stale-pool')]);
    expect(await first).toBe(0);
    expect([...cache.keys()]).toEqual(['load-a']);
    expect(cache.get('load-a')).toBe(original);
  });

  it.each(['access_token', 'project_id'] as const)(
    'does not overwrite a live %s update while storage is pending',
    async (field) => {
      const { store, cache, policy, applyQuotaSnapshot } = fixture();
      await policy.loadAccounts();
      applyQuotaSnapshot.mockClear();
      const old = Promise.withResolvers<CloudAccount[]>();
      vi.mocked(store.getAccounts).mockReturnValueOnce(old.promise);
      const pending = policy.loadAccounts();
      const live = cache.get('load-a');
      if (!live) {
        throw new Error('Fixture entry missing');
      }
      live[field] = 'new-live-value';
      old.resolve([createAccount('load-a')]);
      expect(await pending).toBe(0);
      expect(cache.get('load-a')).toBe(live);
      expect(cache.get('load-a')?.[field]).toBe('new-live-value');
      expect(applyQuotaSnapshot).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'refuses an in-flight snapshot after eviction even if the cache was empty (%s)',
    async (seeded) => {
      const { store, lease } = fixture();
      if (seeded) {
        await lease.loadAccounts();
      }
      const old = Promise.withResolvers<CloudAccount[]>();
      vi.mocked(store.getAccounts).mockReturnValueOnce(old.promise);
      const pending = lease.loadAccounts();
      expect(lease.evictAccount('load-a')).toBe(seeded);
      old.resolve([createAccount('load-a')]);
      expect(await pending).toBe(0);
      expect(lease.getAccountCount()).toBe(0);
    },
  );

  it('keeps strict reload invalidation from clearing an unrelated live quota lock', async () => {
    const { store, lease, tracker } = fixture();
    await lease.loadAccounts();
    const old = Promise.withResolvers<CloudAccount[]>();
    vi.mocked(store.getAccounts).mockReturnValueOnce(old.promise);
    const settled = Promise.allSettled([lease.reloadAllAccountsOrThrow()]);
    tracker.setLockoutUntilIso(
      'unrelated',
      new Date(Date.now() + 3_600_000).toISOString(),
      RateLimitReason.QuotaExhausted,
      'claude-sonnet',
    );
    lease.evictAccount('load-a');
    old.resolve([createAccount('load-a')]);
    expect((await settled)[0]).toMatchObject({
      status: 'rejected',
      reason: { name: 'AccountLeaseLoadSupersededError' },
    });
    expect(tracker.hasActiveQuotaLock('unrelated', 'claude-sonnet')).toBe(true);
    expect(lease.getAccountCount()).toBe(0);
  });
});
