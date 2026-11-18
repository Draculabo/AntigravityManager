import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import type {
  AccountLeaseAccountStore,
  AccountLeaseUpstream,
} from '@/server/gateway/modules/account-lease/interfaces/account-lease-adapters';
import { ModelAvailabilityService } from '@/server/gateway/shared/services/model-availability.service';
import {
  RateLimitReason,
  RateLimitTrackerService,
} from '@/server/gateway/shared/services/rate-limit-tracker.service';
import { ProxyRetryService } from '@/server/gateway/shared/services/proxy-retry.service';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { createAccount } from './proxy-real-path.harness';

const model = 'claude-sonnet';
const services: AccountLeaseService[] = [];
let previous = getServerConfig();

async function fixture() {
  const accounts = [createAccount('selection-a')];
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
    fetchQuota: vi.fn(),
    refreshAccessToken: vi.fn(),
    fetchProjectId: vi.fn(),
    normalizeRefreshedOAuthClientKey: vi.fn(),
  };
  const tracker = new RateLimitTrackerService();
  const availability = new ModelAvailabilityService();
  const lease = new AccountLeaseService(store, upstream, tracker, availability);
  services.push(lease);
  await lease.loadAccounts();
  tracker.setLockoutUntilIso(
    'selection-a',
    new Date(2000).toISOString(),
    RateLimitReason.RateLimitExceeded,
    model,
  );
  return { accounts, store, upstream, tracker, availability, lease };
}

beforeEach(() => {
  previous = getServerConfig();
  vi.useFakeTimers();
  vi.setSystemTime(0);
  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, max_wait_seconds: 2 });
});
afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.onModuleDestroy();
  }
  const remaining = vi.getTimerCount();
  vi.useRealTimers();
  setServerConfig(previous ?? DEFAULT_APP_CONFIG.proxy);
  expect(remaining).toBe(0);
});

describe('selection recovery through the production lease', () => {
  it('honors the ordinary request deadline before starting initial selection waiting', async () => {
    const { lease, upstream } = await fixture();
    const retry = new ProxyRetryService(
      lease,
      { log: vi.fn(), warn: vi.fn() },
      new ModelAvailabilityService(),
    );
    const state = retry.createTokenRetryState(500);
    await retry.getMaxRetryAttempts(model, false, state);
    await expect(retry.selectRetryToken(state, model)).rejects.toThrow(
      'All accounts failed or unhealthy',
    );
    expect(Date.now()).toBe(0);
    expect(upstream.refreshAccessToken).not.toHaveBeenCalled();
    expect(upstream.fetchProjectId).not.toHaveBeenCalled();
  });

  it('cancels initial selection waiting and keeps shared lock evidence', async () => {
    const { lease, tracker, upstream } = await fixture();
    const retry = new ProxyRetryService(
      lease,
      { log: vi.fn(), warn: vi.fn() },
      new ModelAvailabilityService(),
    );
    const state = retry.createTokenRetryState();
    const controller = new AbortController();
    await retry.getMaxRetryAttempts(model, false, state);
    const pending = retry.selectRetryToken(state, model, undefined, false, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await rejected;
    expect(Date.now()).toBe(100);
    expect(tracker.isRateLimited('selection-a', model)).toBe(true);
    expect(upstream.refreshAccessToken).not.toHaveBeenCalled();
    expect(upstream.fetchProjectId).not.toHaveBeenCalled();
  });

  it.each(['capability', 'replacement', 'hard-quota'] as const)(
    'rechecks %s changes before hydration',
    async (change) => {
      const { lease, tracker, availability, store, upstream } = await fixture();
      const pending = lease.getNextToken({ model });
      await vi.advanceTimersByTimeAsync(100);
      if (change === 'capability') {
        availability.mark('selection-a', model, 'model_forbidden');
      } else if (change === 'replacement') {
        await lease.loadAccounts();
      } else {
        tracker.setLockoutUntilIso(
          'selection-a',
          new Date(7_200_000).toISOString(),
          RateLimitReason.QuotaExhausted,
          model,
        );
      }
      await vi.advanceTimersByTimeAsync(1900);
      expect(await pending).toBeNull();
      expect(Date.now()).toBe(2000);
      expect(store.getAccount).not.toHaveBeenCalled();
      expect(upstream.refreshAccessToken).not.toHaveBeenCalled();
      expect(upstream.fetchProjectId).not.toHaveBeenCalled();
      if (change === 'hard-quota') {
        expect(tracker.hasActiveQuotaLock('selection-a', model)).toBe(true);
      }
    },
  );

  it('keeps rotation stable across a reordered account-cache reload', async () => {
    const { lease, accounts, tracker } = await fixture();
    tracker.clearAll();
    accounts.push(createAccount('selection-b'));
    accounts.reverse();
    await lease.loadAccounts();
    expect((await lease.getNextToken({ model }))?.id).toBe('selection-a');
    accounts.reverse();
    await lease.loadAccounts();
    expect((await lease.getNextToken({ model }))?.id).toBe('selection-b');
  });
});
