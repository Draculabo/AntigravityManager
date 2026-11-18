import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudAccount, CloudQuotaData } from '@/modules/cloud-account/types';
import type { TokenResponse } from '@/modules/cloud-account/services/GoogleAPIService';
import {
  AccountLeaseService,
  ImageAccountUnavailableError,
  ImageQueueAbortedError,
  ImageQueueTimeoutError,
} from '@/server/gateway/modules/account-lease/account-lease.service';
import type {
  AccountLeaseAccountStore,
  AccountLeaseUpstream,
} from '@/server/gateway/modules/account-lease/interfaces/account-lease-adapters';
import { ImageAccountSchedulerService } from '@/server/gateway/modules/account-lease/image-account-scheduler.service';
import {
  RateLimitReason,
  RateLimitTrackerService,
} from '@/server/gateway/shared/services/rate-limit-tracker.service';
import { createAccount } from './proxy-real-path.harness';

vi.mock('@/server/server-config', async () => {
  const { DEFAULT_APP_CONFIG } = await import('@/modules/config/types');
  return {
    getServerConfig: () => ({
      ...DEFAULT_APP_CONFIG.proxy,
      max_wait_seconds: 10,
      request_timeout: 10,
      image_scheduler: { per_account_concurrency: 1 },
    }),
  };
});
const model = 'gemini-3.1-flash-image';
const grant: TokenResponse = {
  access_token: 'synthetic-renewed',
  refresh_token: 'synthetic-rotated',
  token_type: 'Bearer',
  expires_in: 3600,
};
const services: AccountLeaseService[] = [];
function quota(fresh: boolean): CloudQuotaData {
  const reset = new Date(Date.now() + (fresh ? 60_000 : -1000)).toISOString();
  return {
    models: { [model]: { percentage: fresh ? 80 : 0, resetTime: reset } },
    quota_groups: [
      {
        display_name: 'Gemini Models',
        buckets: [
          {
            bucket_id: 'gemini-weekly',
            window: 'weekly',
            remaining_fraction: fresh ? 0.8 : 0,
            reset_time: reset,
            observed_at: Date.now() - 1000,
          },
        ],
      },
    ],
  };
}
async function fixture({ expiredToken = true, expiredQuota = true, ids = ['a'] } = {}) {
  const accounts = ids.map(
    (id): CloudAccount => ({
      ...createAccount(id),
      token: {
        ...createAccount(id).token,
        expiry_timestamp: Math.floor(Date.now() / 1000) + (expiredToken ? -10 : 3600),
      },
      quota: quota(!expiredQuota),
    }),
  );
  const store: AccountLeaseAccountStore = {
    getAccounts: vi.fn(async () => structuredClone(accounts)),
    getAccount: vi.fn(async (id) => structuredClone(accounts.find((a) => a.id === id))),
    assertCurrentAccount: (id, guard) => guard(structuredClone(accounts.find((a) => a.id === id))),
    async compareAndUpdateToken(id, _expected, token, guard) {
      await this.updateToken(id, token, guard);
      return true;
    },
    updateToken: vi.fn(async (id, token, guard) => {
      const account = accounts.find((a) => a.id === id);
      guard?.(structuredClone(account));
      if (account) {
        account.token = token;
      }
    }),
    updateQuota: vi.fn(async (id, next, guard) => {
      const account = accounts.find((a) => a.id === id);
      guard?.(structuredClone(account));
      if (account) {
        account.quota = next;
      }
    }),
    mutateHealth: vi.fn(),
  };
  const upstream: AccountLeaseUpstream = {
    fetchQuota: vi.fn(async () => quota(true)),
    refreshAccessToken: vi.fn(async () => grant),
    fetchProjectId: vi.fn(),
    normalizeRefreshedOAuthClientKey: vi.fn((_token, key) => key),
  };
  const scheduler = new ImageAccountSchedulerService();
  const tracker = new RateLimitTrackerService();
  const lease = new AccountLeaseService(store, upstream, tracker, undefined, scheduler, null);
  services.push(lease);
  await lease.loadAccounts();
  return { lease, store, upstream, accounts, scheduler, tracker };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-17T00:00:00Z'));
});
afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.onModuleDestroy();
  }
  const timers = vi.getTimerCount();
  vi.useRealTimers();
  expect(timers).toBe(0);
});

describe('token preparation and image quota recovery', () => {
  it('does not publish renewed credentials when a new hard lock appears during image hydration', async () => {
    const { lease, upstream, store, tracker, scheduler } = await fixture({ expiredQuota: false });
    const entered = Promise.withResolvers<void>(),
      response = Promise.withResolvers<TokenResponse>();
    vi.mocked(upstream.refreshAccessToken).mockImplementation(async () => {
      entered.resolve();
      return response.promise;
    });
    const pending = lease.getNextImageToken({ model });
    const failed = expect(pending).rejects.toBeInstanceOf(ImageAccountUnavailableError);
    await entered.promise;
    tracker.setLockoutUntilIso(
      'a',
      new Date(Date.now() + 60_000).toISOString(),
      RateLimitReason.QuotaExhausted,
      model,
    );
    response.resolve(grant);
    await vi.advanceTimersByTimeAsync(0);
    await failed;
    expect(store.updateToken).not.toHaveBeenCalled();
    expect(scheduler.getInUseFor('a')).toBe(0);
  });

  it('cancels owned cold project discovery without publishing a late project/token snapshot', async () => {
    const { lease, upstream, store, accounts } = await fixture({
      expiredToken: false,
      expiredQuota: false,
    });
    accounts[0].token.project_id = undefined;
    await lease.loadAccounts();
    const entered = Promise.withResolvers<AbortSignal>(),
      project = Promise.withResolvers<string | null>();
    vi.mocked(upstream.fetchProjectId).mockImplementation(async (_token, _proxy, signal) => {
      if (!signal) {
        throw new Error('Missing project cancellation');
      }
      entered.resolve(signal);
      return project.promise;
    });
    const controller = new AbortController();
    const pending = lease.getNextImageToken({ model, signal: controller.signal });
    const failed = expect(pending).rejects.toBeInstanceOf(ImageQueueAbortedError);
    const signal = await entered.promise;
    controller.abort();
    await failed;
    project.resolve('synthetic-late-project');
    await vi.advanceTimersByTimeAsync(0);
    expect(signal.aborted).toBe(true);
    expect(store.updateToken).not.toHaveBeenCalled();
    vi.mocked(upstream.fetchProjectId).mockResolvedValue('synthetic-current-project');
    const selected = await lease.getNextImageToken({ model });
    expect(selected.token.token.project_id).toBe('synthetic-current-project');
    selected.permit.release();
    await vi.advanceTimersByTimeAsync(0);
  });

  it.each(['ordinary', 'image'] as const)(
    'persists renewed credentials before querying quota (%s)',
    async (kind) => {
      const { lease, upstream, store, scheduler } = await fixture();
      const entered = Promise.withResolvers<void>(),
        renewal = Promise.withResolvers<TokenResponse>();
      vi.mocked(upstream.refreshAccessToken).mockImplementation(async () => {
        entered.resolve();
        return renewal.promise;
      });
      vi.mocked(upstream.fetchQuota).mockImplementation(async (access) => {
        expect(access).toBe(grant.access_token);
        expect(store.updateToken).toHaveBeenCalledTimes(1);
        return quota(true);
      });
      const pending =
        kind === 'image' ? lease.getNextImageToken({ model }) : lease.getNextToken({ model });
      await entered.promise;
      expect(scheduler.getInUseFor('a')).toBe(0);
      expect(upstream.fetchQuota).not.toHaveBeenCalled();
      renewal.resolve(grant);
      await vi.advanceTimersByTimeAsync(0);
      const selected = await pending;
      if (selected && 'permit' in selected) {
        expect(selected.token.token.access_token).toBe(grant.access_token);
        selected.permit.release();
      } else {
        expect(selected?.token.access_token).toBe(grant.access_token);
      }
      expect(upstream.refreshAccessToken).toHaveBeenCalledTimes(1);
    },
  );

  it('shares the two-second recovery cap across renewal and quota lookup', async () => {
    const { lease, upstream, store, scheduler } = await fixture();
    const entered = Promise.withResolvers<void>(),
      renewal = Promise.withResolvers<TokenResponse>();
    const quotaEntered = Promise.withResolvers<AbortSignal>(),
      lateQuota = Promise.withResolvers<CloudQuotaData>();
    vi.mocked(upstream.refreshAccessToken).mockImplementation(async () => {
      entered.resolve();
      return renewal.promise;
    });
    vi.mocked(upstream.fetchQuota).mockImplementation(async (_token, _proxy, signal) => {
      if (!signal) {
        throw new Error('Missing quota cancellation');
      }
      quotaEntered.resolve(signal);
      return lateQuota.promise;
    });
    const pending = lease.getNextImageToken({ model });
    const failed = expect(pending).rejects.toBeInstanceOf(ImageAccountUnavailableError);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(1500);
    renewal.resolve(grant);
    await vi.advanceTimersByTimeAsync(0);
    const signal = await quotaEntered.promise;
    await vi.advanceTimersByTimeAsync(500);
    await failed;
    expect(signal.aborted).toBe(true);
    expect(store.updateToken).toHaveBeenCalledTimes(1);
    lateQuota.resolve(quota(true));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.updateQuota).not.toHaveBeenCalled();
    expect(scheduler.getInUseFor('a')).toBe(0);
  });

  it.each(['cancel', 'deadline', 'delete', 'stop'] as const)(
    'does not write a late renewed credential after %s',
    async (mode) => {
      const { lease, upstream, store, accounts, scheduler } = await fixture();
      const entered = Promise.withResolvers<AbortSignal>(),
        renewal = Promise.withResolvers<TokenResponse>();
      vi.mocked(upstream.refreshAccessToken).mockImplementation(
        async (_id, _refresh, _proxy, _client, _health, execution) => {
          if (!execution) {
            throw new Error('Missing renewal ownership');
          }
          entered.resolve(execution.signal);
          return renewal.promise;
        },
      );
      const controller = new AbortController();
      const pending = lease.getNextImageToken({
        model,
        signal: controller.signal,
        selectionDeadlineMs: Date.now() + 50,
      });
      const settled = Promise.allSettled([pending]);
      const signal = await entered.promise;
      if (mode === 'cancel') {
        controller.abort();
      }
      if (mode === 'deadline') {
        await vi.advanceTimersByTimeAsync(50);
      }
      if (mode === 'delete') {
        accounts.splice(0);
        lease.evictAccount('a');
      }
      if (mode === 'stop') {
        await lease.onModuleDestroy();
      }
      const [result] = await settled;
      expect(result.status).toBe('rejected');
      expect(signal.aborted).toBe(true);
      renewal.resolve(grant);
      await vi.advanceTimersByTimeAsync(0);
      expect(store.updateToken).not.toHaveBeenCalled();
      expect(store.updateQuota).not.toHaveBeenCalled();
      expect(upstream.fetchQuota).not.toHaveBeenCalled();
      expect(scheduler.getInUseFor('a')).toBe(0);
    },
  );

  it('stops before quota lookup after token persistence fails', async () => {
    const { lease, upstream, store } = await fixture();
    vi.mocked(store.updateToken).mockRejectedValue(
      new Error('Synthetic credential persistence failure'),
    );
    const pending = lease.getNextToken({ model });
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toBeNull();
    expect(upstream.fetchQuota).not.toHaveBeenCalled();
  });

  it('does not publish a renewal if the stored account disappears before credential persistence', async () => {
    const { lease, upstream, store } = await fixture();
    vi.mocked(store.getAccount).mockResolvedValue(undefined);
    const pending = lease.getNextToken({ model });
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toBeNull();
    expect(store.updateToken).not.toHaveBeenCalled();
    expect(upstream.fetchQuota).not.toHaveBeenCalled();
  });

  it('reloads a committed token after cancellation instead of replaying its grant', async () => {
    const { lease, upstream, store, accounts } = await fixture();
    const controller = new AbortController();
    vi.mocked(store.updateToken).mockImplementation(async (id, token, guard) => {
      const account = accounts.find((a) => a.id === id);
      guard?.(structuredClone(account));
      if (account) {
        account.token = token;
      }
      controller.abort();
    });
    const pending = lease.getNextToken({ model, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toBeNull();
    expect(upstream.fetchQuota).not.toHaveBeenCalled();
    expect(accounts[0].token.access_token).toBe(grant.access_token);
    await lease.loadAccounts();
    expect((await lease.getNextToken({ model }))?.token.access_token).toBe(grant.access_token);
    expect(upstream.refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it('guards renewal for an image account even when quota is already positive', async () => {
    const { lease, upstream, store, scheduler } = await fixture({ expiredQuota: false });
    const entered = Promise.withResolvers<void>(),
      renewal = Promise.withResolvers<TokenResponse>();
    vi.mocked(upstream.refreshAccessToken).mockImplementation(async () => {
      entered.resolve();
      return renewal.promise;
    });
    const controller = new AbortController();
    const pending = lease.getNextImageToken({ model, signal: controller.signal });
    const failed = expect(pending).rejects.toBeInstanceOf(ImageQueueAbortedError);
    await entered.promise;
    controller.abort();
    await failed;
    renewal.resolve(grant);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.updateToken).not.toHaveBeenCalled();
    expect(scheduler.getInUseFor('a')).toBe(0);
  });

  it('uses the caller deadline for capacity waiting without renewing it after selection', async () => {
    const { lease, scheduler } = await fixture({ expiredToken: false, expiredQuota: false });
    const held = scheduler.tryAcquire('a');
    expect(held).not.toBeNull();
    const pending = lease.getNextImageToken({ model, selectionDeadlineMs: Date.now() + 40 });
    const failed = expect(pending).rejects.toBeInstanceOf(ImageQueueTimeoutError);
    await vi.advanceTimersByTimeAsync(40);
    await failed;
    held?.release();
    expect(scheduler.getInUseFor('a')).toBe(0);
  });

  it('shares one quota probe allowance across busy-account reselection', async () => {
    const { lease, upstream, scheduler } = await fixture({ expiredToken: false, ids: ['a', 'b'] });
    const held = scheduler.tryAcquire('a');
    const pending = lease.getNextImageToken({ model });
    await vi.advanceTimersByTimeAsync(0);
    expect(upstream.fetchQuota).toHaveBeenCalledTimes(1);
    held?.release();
    const selected = await pending;
    expect(selected.token.id).toBe('a');
    selected.permit.release();
    expect(upstream.fetchQuota).toHaveBeenCalledTimes(1);
  });
});
