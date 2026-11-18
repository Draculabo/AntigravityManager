import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AccountLeaseSelectionPolicy,
  type AccountLeaseSelectionRequest,
} from '@/server/gateway/modules/account-lease/policies/account-lease-selection.policy';
import { AccountLeaseSelectionWait } from '@/server/gateway/modules/account-lease/policies/account-lease-selection-wait';

function request(
  overrides: Partial<AccountLeaseSelectionRequest<string>> = {},
): AccountLeaseSelectionRequest<string> {
  return {
    allTokens: [
      ['b', 'b'],
      ['a', 'a'],
      ['c', 'c'],
    ],
    now: Date.now(),
    accountCooldowns: new Map(),
    rateLimitTracker: {
      isRateLimited: () => false,
      getRemainingWaitSeconds: () => 0,
    },
    config: {
      quotaAwareSchedulingEnabled: true,
      parityEnabled: false,
      parityShadowEnabled: false,
      schedulingMode: 'balance',
      accountSelectionStrategy: 'balanced',
      maxWaitMs: 2000,
      noGoMismatchRateThreshold: 0.15,
      noGoErrorRateThreshold: 0.4,
    },
    logger: { warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

describe('account selection ordering and recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    const remaining = vi.getTimerCount();
    vi.useRealTimers();
    expect(remaining).toBe(0);
  });

  it.each([false, true])(
    'rotates deterministically across pool permutations (parity=%s)',
    async (parityEnabled) => {
      const policy = new AccountLeaseSelectionPolicy();
      const input = request();
      input.config.parityEnabled = parityEnabled;
      const selected = [];
      for (const entries of [input.allTokens, [...input.allTokens].reverse(), input.allTokens]) {
        selected.push((await policy.selectCandidate({ ...input, allTokens: entries }))?.[0]);
      }
      expect(selected).toEqual(['a', 'b', 'c']);
      expect(input.allTokens.map(([id]) => id)).toEqual(['b', 'a', 'c']);
      policy.resetSelectionState();
      expect((await policy.selectCandidate(input))?.[0]).toBe('a');
    },
  );

  it('uses stable order without changing quota weights or account-first affinity', async () => {
    const policy = new AccountLeaseSelectionPolicy();
    const input = request({ model: 'model', getModelQuota: (id) => (id === 'b' ? 90 : 10) });
    const selections = [];
    for (let index = 0; index < 5; index++) {
      selections.push((await policy.selectCandidate(input))?.[0]);
    }
    expect(selections).toEqual(['a', 'b', 'b', 'b', 'c']);
    input.config.accountSelectionStrategy = 'account-first';
    input.getModelQuota = (id) => (id === 'b' ? 90 : 0);
    expect((await policy.selectCandidate(input))?.[0]).toBe('b');
    input.getModelQuota = () => 80;
    expect((await policy.selectCandidate(input))?.[0]).toBe('a');
    policy.bindSession('session', 'c', 10_000);
    expect((await policy.selectCandidate({ ...input, sessionKey: 'session' }))?.[0]).toBe('c');
    input.config.preferredAccountId = 'b';
    expect((await policy.selectCandidate(input))?.[0]).toBe('b');
  });

  it('refuses an unaffordable full-pool wait without registering a timer', async () => {
    const input = request({
      rateLimitTracker: { isRateLimited: () => true, getRemainingWaitSeconds: () => 2 },
    });
    input.config.maxWaitMs = 100;
    const pending = new AccountLeaseSelectionPolicy().selectCandidate(input);
    await vi.runAllTimersAsync();
    expect(await pending).toBeNull();
    expect(Date.now()).toBe(0);
  });

  it.each(['balanced', 'account-first'] as const)(
    'waits for a short pool cooldown once (%s)',
    async (accountSelectionStrategy) => {
      const input = request({
        accountCooldowns: new Map([
          ['a', 1000],
          ['b', 2000],
          ['c', 5000],
        ]),
      });
      input.config.accountSelectionStrategy = accountSelectionStrategy;
      const pending = new AccountLeaseSelectionPolicy().selectCandidate(input);
      await vi.advanceTimersByTimeAsync(1000);
      expect((await pending)?.[0]).toBe('a');
      expect(input.accountCooldowns.get('c')).toBe(5000);
    },
  );

  it('does not return a pre-wait candidate if all accounts become locked while waiting', async () => {
    const policy = new AccountLeaseSelectionPolicy();
    policy.bindSession('session', 'a', 10_000);
    const input = request({
      sessionKey: 'session',
      rateLimitTracker: {
        isRateLimited: (id) => id === 'a' || Date.now() >= 1000,
        getRemainingWaitSeconds: (id) => (id === 'a' ? 1 : 10),
      },
    });
    input.config.parityEnabled = true;
    input.config.schedulingMode = 'cache-first';
    const pending = policy.selectCandidate(input);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toBeNull();
    expect(Date.now()).toBe(1000);
  });

  it.each(['cancelled', 'replaced'] as const)('rechecks %s state after a wait', async (change) => {
    const controller = new AbortController();
    let current = true;
    const input = request({
      signal: controller.signal,
      isCurrentCandidate: () => current,
      rateLimitTracker: {
        isRateLimited: () => Date.now() < 1000,
        getRemainingWaitSeconds: () => 1,
      },
    });
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = new AccountLeaseSelectionPolicy().selectCandidate(input);
    await vi.advanceTimersByTimeAsync(100);
    if (change === 'cancelled') {
      controller.abort();
    } else {
      current = false;
      await vi.advanceTimersByTimeAsync(900);
    }
    expect(await pending).toBeNull();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(Date.now()).toBe(change === 'cancelled' ? 100 : 1000);
  });

  it('shares one non-renewing wait budget across hydration failover selections', async () => {
    const policy = new AccountLeaseSelectionPolicy();
    const waitBudget = new AccountLeaseSelectionWait(1500);
    const input = request({
      waitBudget,
      rateLimitTracker: {
        isRateLimited: () => Date.now() < 1000 || Date.now() >= 1100,
        getRemainingWaitSeconds: () => 1,
      },
    });
    const first = policy.selectCandidate(input);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await first)?.[0]).toBe('a');
    await vi.advanceTimersByTimeAsync(100);
    expect(await policy.selectCandidate({ ...input, now: Date.now() })).toBeNull();
    expect(Date.now()).toBe(1100);
  });

  it('does not start a wait that exceeds the remaining request deadline', async () => {
    const input = request({
      waitBudget: new AccountLeaseSelectionWait(10_000, undefined, 500),
      rateLimitTracker: { isRateLimited: () => true, getRemainingWaitSeconds: () => 1 },
    });
    expect(await new AccountLeaseSelectionPolicy().selectCandidate(input)).toBeNull();
    expect(Date.now()).toBe(0);
  });

  it('returns no candidate without starting work for an already aborted selection', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await new AccountLeaseSelectionPolicy().selectCandidate(
        request({ signal: controller.signal }),
      ),
    ).toBeNull();
  });

  it('respects an extended lock and never starts a second recovery wait', async () => {
    const input = request({
      rateLimitTracker: {
        isRateLimited: () => true,
        getRemainingWaitSeconds: () => (Date.now() < 1000 ? 1 : 10),
      },
    });
    const pending = new AccountLeaseSelectionPolicy().selectCandidate(input);
    await vi.runAllTimersAsync();
    expect(await pending).toBeNull();
    expect(Date.now()).toBe(1000);
  });
});
