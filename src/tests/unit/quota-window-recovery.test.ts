import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudAccount, CloudQuotaData } from '@/modules/cloud-account/types';
import { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import type {
  AccountLeaseAccountStore,
  AccountLeaseUpstream,
} from '@/server/gateway/modules/account-lease/interfaces/account-lease-adapters';
import {
  RateLimitReason,
  RateLimitTrackerService,
} from '@/server/gateway/shared/services/rate-limit-tracker.service';
import { createAccount } from './proxy-real-path.harness';

const config = vi.hoisted(() => ({ strategy: 'balanced' as 'balanced' | 'account-first' }));
vi.mock('@/server/server-config', async () => {
  const { DEFAULT_APP_CONFIG } = await import('@/modules/config/types');
  return {
    getServerConfig: () => ({
      ...DEFAULT_APP_CONFIG.proxy,
      account_selection_strategy: config.strategy,
      max_wait_seconds: 10,
    }),
  };
});
const model = 'claude-sonnet-4-6';
const services: AccountLeaseService[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function quota(fresh = false, weeklyActive = false): CloudQuotaData {
  const reset = new Date(Date.now() + (fresh || weeklyActive ? 60_000 : -1000)).toISOString();
  return {
    models: { [model]: { percentage: fresh ? 80 : 0, resetTime: reset } },
    quota_groups: [
      {
        display_name: 'Claude and GPT models',
        buckets: [
          {
            bucket_id: '3p-5h',
            window: '5h',
            remaining_fraction: fresh ? 0.8 : 0,
            reset_time: fresh ? reset : new Date(Date.now() - 1000).toISOString(),
            observed_at: Date.now() - 1000,
          },
          {
            bucket_id: '3p-week',
            window: 'weekly',
            remaining_fraction: fresh ? 0.5 : 0,
            reset_time: reset,
            observed_at: Date.now() - 1000,
          },
        ],
      },
    ],
  };
}
async function fixture(accounts: CloudAccount[] = [{ ...createAccount('a'), quota: quota() }]) {
  const store: AccountLeaseAccountStore = {
    getAccounts: vi.fn(async () => structuredClone(accounts)),
    getAccount: vi.fn(async (id) => structuredClone(accounts.find((account) => account.id === id))),
    assertCurrentAccount: (id, guard) =>
      guard(structuredClone(accounts.find((account) => account.id === id))),
    updateQuota: vi.fn(async (id, next, guard) => {
      const current = accounts.find((account) => account.id === id);
      guard?.(structuredClone(current));
      if (current) {
        current.quota = next;
      }
    }),
    async compareAndUpdateToken(id, _expected, token, guard) {
      await this.updateToken(id, token, guard);
      return true;
    },
    updateToken: vi.fn(),
    mutateHealth: vi.fn(),
  };
  const upstream: AccountLeaseUpstream = {
    fetchQuota: vi.fn(async () => quota(true)),
    refreshAccessToken: vi.fn(),
    fetchProjectId: vi.fn(),
    normalizeRefreshedOAuthClientKey: vi.fn(),
  };
  const tracker = new RateLimitTrackerService();
  const lease = new AccountLeaseService(store, upstream, tracker);
  services.push(lease);
  await lease.loadAccounts();
  return { lease, store, upstream, tracker, accounts };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-17T00:00:00Z'));
  config.strategy = 'balanced';
});
afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.onModuleDestroy();
  }
  const timers = vi.getTimerCount();
  vi.useRealTimers();
  expect(timers).toBe(0);
});

describe('bounded expired-window recovery through the lease service', () => {
  it.each(['balanced', 'account-first'] as const)(
    'refreshes expired protection before leasing (%s)',
    async (strategy) => {
      config.strategy = strategy;
      const { lease, upstream } = await fixture();
      expect((await lease.getNextToken({ model }))?.id).toBe('a');
      expect(upstream.fetchQuota).toHaveBeenCalledExactlyOnceWith(
        'access-a',
        undefined,
        expect.any(AbortSignal),
      );
      expect(upstream.refreshAccessToken).not.toHaveBeenCalled();
    },
  );

  it('uses an available account without delaying it for an expired account', async () => {
    const { lease, upstream } = await fixture([
      { ...createAccount('a'), quota: quota() },
      { ...createAccount('b'), quota: quota(true) },
    ]);
    expect((await lease.getNextToken({ model }))?.id).toBe('b');
    expect(upstream.fetchQuota).not.toHaveBeenCalled();
  });

  it('does not probe past an active weekly window or another hard lock', async () => {
    const first = await fixture([{ ...createAccount('weekly'), quota: quota(false, true) }]);
    expect(await first.lease.getNextToken({ model })).toBeNull();
    expect(first.upstream.fetchQuota).not.toHaveBeenCalled();
    const second = await fixture();
    second.tracker.setLockoutUntilIso(
      'a',
      new Date(Date.now() + 60_000).toISOString(),
      RateLimitReason.QuotaExhausted,
      model,
    );
    expect(await second.lease.getNextToken({ model })).toBeNull();
    expect(second.upstream.fetchQuota).not.toHaveBeenCalled();
    expect(second.tracker.hasActiveQuotaLock('a', model)).toBe(true);
  });

  it.each(['zero-budget', 'expired-deadline', 'excluded'] as const)(
    'does not probe without eligibility/budget (%s)',
    async (mode) => {
      const { lease, upstream } = await fixture();
      expect(
        await lease.getNextToken({
          model,
          ...(mode === 'zero-budget'
            ? { allowSelectionWait: false }
            : mode === 'expired-deadline'
              ? { selectionDeadlineMs: Date.now() }
              : { excludeAccountIds: ['a'] }),
        }),
      ).toBeNull();
      expect(upstream.fetchQuota).not.toHaveBeenCalled();
    },
  );

  it('retains incomplete evidence and throttles retries without fabricating a new cycle', async () => {
    const { lease, store, upstream, accounts } = await fixture();
    const before = structuredClone(accounts[0].quota);
    vi.mocked(upstream.fetchQuota).mockResolvedValue({ models: quota(true).models });
    expect(await lease.getNextToken({ model })).toBeNull();
    expect(await lease.getNextToken({ model })).toBeNull();
    expect(upstream.fetchQuota).toHaveBeenCalledTimes(1);
    expect(store.updateQuota).not.toHaveBeenCalled();
    expect(accounts[0].quota).toEqual(before);
    expect(lease.isRateLimited('a', model)).toBe(true);
    expect(lease.getEligibleRetryAccountCount({ model, excludeAccountIds: [] })).toBe(0);
    expect(lease.getOrdinaryRetryWaitMs({ model })).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    vi.mocked(upstream.fetchQuota).mockResolvedValue(quota(true));
    expect((await lease.getNextToken({ model }))?.id).toBe('a');
    expect(upstream.fetchQuota).toHaveBeenCalledTimes(2);
  });

  it('makes at most one account probe even when the whole pool fails', async () => {
    const { lease, upstream } = await fixture([
      { ...createAccount('a'), quota: quota() },
      { ...createAccount('b'), quota: quota() },
    ]);
    vi.mocked(upstream.fetchQuota).mockRejectedValue(
      new Error('Synthetic quota transport failure'),
    );
    expect(await lease.getNextToken({ model })).toBeNull();
    expect(upstream.fetchQuota).toHaveBeenCalledTimes(1);
  });

  it('keeps a fresh zero window locked instead of inventing recovery', async () => {
    const { lease, upstream, tracker, store } = await fixture();
    const observed = quota(true);
    observed.quota_groups![0].buckets[1].remaining_fraction = 0;
    vi.mocked(upstream.fetchQuota).mockResolvedValue(observed);
    expect(await lease.getNextToken({ model })).toBeNull();
    expect(store.updateQuota).toHaveBeenCalledTimes(1);
    expect(tracker.hasActiveQuotaLock('a', model)).toBe(true);
  });

  it('shares no waiting queue with another selection already probing the account', async () => {
    const { lease, upstream } = await fixture();
    const entered = deferred<void>(),
      response = deferred<CloudQuotaData>();
    vi.mocked(upstream.fetchQuota).mockImplementation(async () => {
      entered.resolve();
      return response.promise;
    });
    const first = lease.getNextToken({ model });
    await entered.promise;
    expect(await lease.getNextToken({ model })).toBeNull();
    response.resolve(quota(true));
    expect((await first)?.id).toBe('a');
    expect(upstream.fetchQuota).toHaveBeenCalledTimes(1);
  });

  it.each(['deadline', 'cap', 'cancel', 'stop', 'delete', 'clock-shift', 'new-lock'] as const)(
    'suppresses late publication after %s',
    async (mode) => {
      const { lease, upstream, store, accounts, tracker } = await fixture();
      const entered = deferred<AbortSignal>(),
        response = deferred<CloudQuotaData>();
      vi.mocked(upstream.fetchQuota).mockImplementation(async (_access, _proxy, signal) => {
        if (!signal) {
          throw new Error('Missing recovery cancellation');
        }
        entered.resolve(signal);
        return response.promise;
      });
      const controller = new AbortController();
      const pending = lease.getNextToken({
        model,
        signal: controller.signal,
        selectionDeadlineMs: Date.now() + (mode === 'cap' ? 10_000 : 50),
      });
      const upstreamSignal = await entered.promise;
      if (mode === 'deadline') {
        await vi.advanceTimersByTimeAsync(50);
      }
      if (mode === 'cap') {
        await vi.advanceTimersByTimeAsync(2000);
      }
      if (mode === 'cancel') {
        controller.abort(new Error('Synthetic cancellation'));
      }
      if (mode === 'stop') {
        await lease.onModuleDestroy();
      }
      if (mode === 'delete') {
        accounts.splice(0);
        lease.evictAccount('a');
        response.resolve(quota(true));
      }
      if (mode === 'clock-shift') {
        vi.setSystemTime(Date.now() + 1000);
        response.resolve(quota(true));
      }
      if (mode === 'new-lock') {
        tracker.setLockoutUntilIso(
          'a',
          new Date(Date.now() + 60_000).toISOString(),
          RateLimitReason.QuotaExhausted,
          model,
        );
        response.resolve(quota(true));
      }
      expect(await pending).toBeNull();
      expect(upstreamSignal.aborted).toBe(mode !== 'clock-shift' && mode !== 'new-lock');
      if (mode === 'cap') {
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await lease.getNextToken({ model })).toBeNull();
        expect(upstream.fetchQuota).toHaveBeenCalledTimes(1);
      }
      response.resolve(quota(true));
      await response.promise;
      await vi.advanceTimersByTimeAsync(0);
      expect(store.updateQuota).not.toHaveBeenCalled();
    },
  );
});
