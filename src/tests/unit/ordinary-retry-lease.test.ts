import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import type {
  AccountLeaseAccountStore,
  AccountLeaseUpstream,
} from '@/server/gateway/modules/account-lease/interfaces/account-lease-adapters';
import { ProxyRetryService } from '@/server/gateway/shared/services/proxy-retry.service';
import {
  RateLimitReason,
  RateLimitTrackerService,
} from '@/server/gateway/shared/services/rate-limit-tracker.service';
import { ModelAvailabilityService } from '@/server/gateway/shared/services/model-availability.service';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { UpstreamRequestError } from '@/server/gateway/common/exceptions/upstream-request.exception';
import { createAccount } from './proxy-real-path.harness';
import type { CloudAccount } from '@/modules/cloud-account/types';

const model = 'claude-sonnet';
const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
const services: AccountLeaseService[] = [];
function fixture(size = 1) {
  const accounts: Array<CloudAccount & { quota: NonNullable<CloudAccount['quota']> }> = [
    'lease-a',
    'lease-b',
  ]
    .slice(0, size)
    .map((id) => ({
      ...createAccount(id),
      quota: { models: { [model]: { percentage: 80, resetTime: '' } } },
    }));
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
  const policy = new ProxyRetryService(lease, { log: vi.fn(), warn: vi.fn() }, availability);
  const state = policy.createTokenRetryState();
  return { accounts, store, upstream, tracker, lease, policy, state };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, account_selection_strategy: 'account-first' });
});
afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.onModuleDestroy();
  }
  vi.useRealTimers();
  setServerConfig(previous);
});

describe('ordinary retry waiting with the real account lease and tracker', () => {
  it('waits for the live cooldown and re-enters using the existing account-first policy', async () => {
    const { policy, state, lease, tracker, upstream } = fixture(2);
    expect(await policy.getMaxRetryAttempts(model, false, state)).toBe(4);
    for (const id of ['lease-a', 'lease-b']) {
      const selected = policy.selectRetryToken(state, model);
      await vi.runAllTimersAsync();
      const token = await selected;
      expect(token?.id).toBe(id);
      const error = new UpstreamRequestError({
        message: 'limited',
        status: 429,
        headers: { retryAfter: '2' },
      });
      policy.recordFailure(state, error);
      expect(await policy.prepareGraceRetry(state, token!, error, 'lease')).toBe(false);
      await policy.applyUpstreamPenalty(id, model, error);
    }
    expect(lease.getOrdinaryRetryWaitMs({ model })).toBe(2000);
    const next = policy.selectRetryToken(state, model);
    await vi.runAllTimersAsync();
    expect((await next)?.id).toBe('lease-a');
    expect(Date.now()).toBe(2050);
    expect(tracker.getRemainingWaitSeconds('lease-b', model)).toBe(0);
    expect(upstream.refreshAccessToken).not.toHaveBeenCalled();
    expect(upstream.fetchQuota).not.toHaveBeenCalled();
    expect(upstream.fetchProjectId).not.toHaveBeenCalled();
  });

  it('does not bypass a long transient lock after the single-account 30-second cap', async () => {
    const { policy, state, lease, tracker } = fixture();
    await policy.getMaxRetryAttempts(model, false, state);
    const token = await policy.selectRetryToken(state, model);
    const error = new UpstreamRequestError({
      message: 'limited',
      status: 429,
      headers: { retryAfter: '90' },
    });
    policy.recordFailure(state, error);
    expect(await policy.prepareGraceRetry(state, token!, error, 'lease')).toBe(false);
    await policy.applyUpstreamPenalty('lease-a', model, error);
    const next = policy.selectRetryToken(state, model);
    await vi.runAllTimersAsync();
    expect(await next).toBeNull();
    expect(Date.now()).toBe(30_000);
    expect(tracker.getRemainingWaitSeconds('lease-a', model)).toBe(60);
    expect(lease.getOrdinaryRetryWaitMs({ model })).toBe(60_000);
  });

  it('does not stack cache-first waiting after the capped retry wait', async () => {
    setServerConfig({
      ...DEFAULT_APP_CONFIG.proxy,
      account_selection_strategy: 'balanced',
      scheduling_mode: 'cache-first',
    });
    const { policy, state, tracker } = fixture();
    await policy.getMaxRetryAttempts(model, false, state);
    const token = await policy.selectRetryToken(state, model, 'sticky-controlled');
    const error = new UpstreamRequestError({
      message: 'limited',
      status: 429,
      headers: { retryAfter: '31' },
    });
    policy.recordFailure(state, error);
    expect(await policy.prepareGraceRetry(state, token!, error, 'lease')).toBe(false);
    await policy.applyUpstreamPenalty('lease-a', model, error);
    const next = policy.selectRetryToken(state, model, 'sticky-controlled');
    await vi.runAllTimersAsync();
    expect(await next).toBeNull();
    expect(Date.now()).toBe(30_000);
    expect(tracker.getRemainingWaitSeconds('lease-a', model)).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps explicit hard quota evidence without waiting or clearing its deadline', async () => {
    const { policy, state, lease, tracker } = fixture();
    await policy.getMaxRetryAttempts(model, false, state);
    const token = await policy.selectRetryToken(state, model);
    const error = new UpstreamRequestError({
      message: 'QUOTA_EXHAUSTED',
      status: 429,
      headers: { retryAfter: '7200' },
      body: 'QUOTA_EXHAUSTED',
    });
    policy.recordFailure(state, error);
    expect(await policy.prepareGraceRetry(state, token!, error, 'lease')).toBe(false);
    await policy.applyUpstreamPenalty('lease-a', model, error);
    expect(lease.getOrdinaryRetryWaitMs({ model })).toBeNull();
    expect(await policy.selectRetryToken(state, model)).toBeNull();
    expect(Date.now()).toBe(0);
    expect(tracker.getRemainingWaitSeconds('lease-a', model)).toBe(7200);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['deleted', 'oauth-blocked', 'validation', 'hard-quota'] as const)(
    'does not resurrect a grace token after it becomes %s',
    async (reason) => {
      const { policy, state, lease, accounts, tracker } = fixture();
      await policy.getMaxRetryAttempts(model, false, state);
      const token = await policy.selectRetryToken(state, model);
      const error = new UpstreamRequestError({
        message: 'limited',
        status: 429,
        headers: { retryAfter: '12' },
      });
      policy.recordFailure(state, error);
      const prepared = policy.prepareGraceRetry(state, token!, error, 'lease');
      await vi.advanceTimersByTimeAsync(1000);
      if (reason === 'deleted') {
        accounts.splice(0);
        lease.evictAccount('lease-a');
      } else if (reason === 'oauth-blocked') {
        lease.updateAccountOAuthHealth('lease-a', { refresh_blocked: true });
      } else if (reason === 'validation') {
        await lease.markValidationRequired({ accountId: 'lease-a' });
      } else {
        tracker.setLockoutUntilIso(
          'lease-a',
          new Date(7_200_000).toISOString(),
          RateLimitReason.QuotaExhausted,
          model,
        );
      }
      await vi.runAllTimersAsync();
      // Identity/health invalidation now stops at the post-wait fence; a later hard
      // route lock is independently rejected when the prepared token is selected.
      expect(await prepared).toBe(reason === 'hard-quota');
      if (reason !== 'hard-quota') {
        expect(state.graceRetryToken).toBeNull();
      }
      expect(await policy.selectRetryToken(state, model)).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('observes depleted account-first quotas and forbidden accounts without hydration', async () => {
    const { lease, tracker, accounts, store, upstream } = fixture(2);
    accounts[0].quota.models[model].percentage = 0;
    await lease.loadAccounts();
    expect(lease.getOrdinaryRetryWaitMs({ model, accountId: 'lease-a' })).toBeNull();
    lease.markAsForbidden('lease-b');
    expect(lease.getOrdinaryRetryWaitMs({ model })).toBeNull();
    tracker.setLockoutUntilIso(
      'lease-a',
      new Date(7200_000).toISOString(),
      RateLimitReason.QuotaExhausted,
      'gemini-3-flash',
    );
    expect(lease.getOrdinaryRetryWaitMs({ model: 'unknown-model' })).toBeNull();
    expect(store.getAccount).not.toHaveBeenCalled();
    expect(upstream.fetchQuota).not.toHaveBeenCalled();
    expect(upstream.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('checks hard quota on the physical route while keeping another model eligible', async () => {
    const { lease, accounts, tracker } = fixture();
    const requested = 'claude-sonnet-4-6-thinking';
    const physical = 'claude-sonnet-4-6';
    accounts[0].quota.models = {
      [physical]: { percentage: 80, resetTime: '', display_name: 'Claude Sonnet 4.6 (Thinking)' },
      'gemini-3.1-pro-low': { percentage: 80, resetTime: '' },
    };
    await lease.loadAccounts();
    expect(lease.resolveDynamicModelForAccount('lease-a', requested)).toBe(physical);
    tracker.setLockoutUntilIso(
      'lease-a',
      new Date(7_200_000).toISOString(),
      RateLimitReason.QuotaExhausted,
      physical,
    );
    expect(lease.getOrdinaryRetryWaitMs({ model: requested })).toBeNull();
    expect(lease.getOrdinaryRetryWaitMs({ model: 'gemini-3.1-pro-low' })).toBe(0);
  });
});
