import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import type {
  AccountLeaseAccountStore,
  AccountLeaseUpstream,
} from '@/server/gateway/modules/account-lease/interfaces/account-lease-adapters';
import { ProxyRetryService } from '@/server/gateway/shared/services/proxy-retry.service';
import { ModelAvailabilityService } from '@/server/gateway/shared/services/model-availability.service';
import { UpstreamRequestError } from '@/server/gateway/common/exceptions/upstream-request.exception';
import { AccountLeaseLimitPolicy } from '@/server/gateway/modules/account-lease/policies/account-lease-limit.policy';
import { RateLimitTrackerService } from '@/server/gateway/shared/services/rate-limit-tracker.service';
import { createAccount } from './proxy-real-path.harness';

const drains: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const drain of drains.splice(0)) {
    await drain();
  }
  vi.restoreAllMocks();
});

async function fixture(withoutProject = false) {
  const account = createAccount('late-account');
  if (withoutProject) {
    account.token.project_id = undefined;
  }
  const store: AccountLeaseAccountStore = {
    getAccounts: vi.fn(async () => [structuredClone(account)]),
    getAccount: vi.fn(async () => structuredClone(account)),
    async compareAndUpdateToken(id, _expected, token, guard) {
      await this.updateToken(id, token, guard);
      return true;
    },
    updateToken: vi.fn(async (_id, token, guard) => {
      guard?.(structuredClone(account));
      account.token = structuredClone(token);
    }),
    updateQuota: vi.fn(),
    mutateHealth: vi.fn(),
  };
  const upstream: AccountLeaseUpstream = {
    fetchQuota: vi.fn(),
    refreshAccessToken: vi.fn(),
    fetchProjectId: vi.fn(),
    normalizeRefreshedOAuthClientKey: vi.fn(),
  };
  const availability = new ModelAvailabilityService();
  const lease = new AccountLeaseService(
    store,
    upstream,
    new RateLimitTrackerService(),
    availability,
  );
  drains.push(() => lease.onModuleDestroy());
  const token = await lease.getNextToken({ model: 'gemini-3-flash' });
  if (!token) {
    throw new Error('Missing fixture lease');
  }
  const retry = new ProxyRetryService(lease, { log: vi.fn(), warn: vi.fn() }, availability);
  return { lease, retry, token, availability, store, upstream };
}

describe('late account completion effects', () => {
  it('rejects a grace lease replaced during the final ordinary-round wait', async () => {
    const { lease, retry, token } = await fixture();
    const state = retry.createTokenRetryState();
    state.graceRetryToken = token;
    vi.spyOn(state.ordinaryRounds, 'wait').mockImplementationOnce(async () => {
      lease.evictAccount(token.id);
      await lease.loadAccounts();
      return true;
    });
    expect(await retry.selectRetryToken(state, 'gemini-3-flash')).toBeNull();
    expect(state.selectedToken).toBeNull();
    expect(state.graceRetryToken).toBeNull();
  });

  it('does not punish a newly discovered project for the older fallback-project request', async () => {
    const { lease, retry, token, upstream, availability } = await fixture(true);
    vi.mocked(upstream.fetchProjectId).mockResolvedValue('new-project');
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 300_001);
    const replacement = await lease.getNextToken({ model: 'gemini-3-flash' });
    expect(replacement?.token.project_id).toBe('new-project');
    expect(lease.isLeaseCurrent(token)).toBe(false);
    await retry.applyUpstreamPenalty(
      token.id,
      'gemini-3-flash',
      new UpstreamRequestError({ status: 404, message: 'Model gemini-3-flash is not supported' }),
      () => lease.isLeaseCurrent(token),
    );
    expect(availability.getSnapshot()).toEqual([]);
  });
  it.each([401, 403, 404, 429, 503])(
    'does not apply a late HTTP %i penalty to a reloaded same-ID account',
    async (status) => {
      const { lease, retry, token, availability, store } = await fixture();
      lease.evictAccount(token.id);
      await lease.loadAccounts();
      const error = new UpstreamRequestError({
        status,
        message: status === 404 ? 'Model gemini-3-flash is not supported' : 'synthetic failure',
        body: status === 429 ? 'retry after 30s' : undefined,
      });
      await retry.applyUpstreamPenalty(token.id, 'gemini-3-flash', error, () =>
        lease.isLeaseCurrent(token),
      );
      expect(availability.getSnapshot()).toEqual([]);
      expect(lease.getRemainingRateLimitWait(token.id, 'gemini-3-flash')).toBe(0);
      expect(store.mutateHealth).not.toHaveBeenCalled();
      expect(await lease.getNextToken({ model: 'gemini-3-flash' })).not.toBeNull();
    },
  );

  it('does not schedule a stale image grace retry and releases its permit', async () => {
    const { lease, retry, token } = await fixture();
    lease.evictAccount(token.id);
    const state = retry.createTokenRetryState();
    const release = vi.fn();
    state.imagePermit = { release };
    expect(
      await retry.prepareScheduledImageRetry(
        state,
        token,
        'gemini-3-pro-image',
        new UpstreamRequestError({ status: 429, message: 'retry after 1s' }),
        'synthetic',
      ),
    ).toBe(false);
    expect(release).toHaveBeenCalledExactlyOnceWith();
    expect(state.graceRetryToken).toBeNull();
  });

  it('retains the original error in request-local failure reporting when account effects are suppressed', async () => {
    const { lease, retry, token } = await fixture();
    lease.evictAccount(token.id);
    const error = new UpstreamRequestError({
      status: 403,
      message: 'synthetic permission failure',
    });
    const state = retry.createTokenRetryState();
    state.selectedToken = token;
    retry.recordFailure(state, error);
    await retry.applyUpstreamPenalty(token.id, 'gemini-3-flash', error, () =>
      lease.isLeaseCurrent(token),
    );
    expect(retry.resolveTerminalError(state, error)).toBe(error);
  });

  it('does not recreate a fallback lock after ownership changes during quota reconciliation', async () => {
    const tracker = new RateLimitTrackerService();
    const read = Promise.withResolvers<'unavailable'>();
    const entered = Promise.withResolvers<void>();
    let current = true;
    const setPrecise = vi.fn(() => false);
    const policy = new AccountLeaseLimitPolicy({
      rateLimitCooldownMs: 1000,
      forbiddenCooldownMs: 1000,
      resolveAccountId: (id) => id,
      getCircuitBreakerBackoffSteps: () => [60],
      refreshRealtimeQuotaAndReconcileLimit: () => {
        entered.resolve();
        return read.promise;
      },
      setPreciseLockoutFromCachedQuota: setPrecise,
      logger: { warn: vi.fn() },
      rateLimitTracker: tracker,
    });
    const pending = policy.markFromUpstreamError({
      accountIdOrEmail: 'late-account',
      model: 'gemini-3-flash',
      status: 429,
      body: 'quota exhausted',
      isCurrent: () => current,
    });
    await entered.promise;
    current = false;
    read.resolve('unavailable');
    await pending;
    expect(setPrecise).not.toHaveBeenCalled();
    expect(tracker.getRemainingWaitSeconds('late-account', 'gemini-3-flash')).toBe(0);
  });
});
