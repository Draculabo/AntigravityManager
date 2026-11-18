import { describe, expect, it, vi } from 'vitest';
import { AccountLeaseAffinity } from '@/server/gateway/modules/account-lease/policies/account-lease-affinity';
import { createAccount } from './proxy-real-path.harness';
import {
  AccountLeaseSelectionPolicy,
  type AccountLeaseSelectionConfig,
  type AccountLeaseSelectionRequest,
} from '@/server/gateway/modules/account-lease/policies/account-lease-selection.policy';

interface TestToken {
  email: string;
  proxy_priority?: number;
  proxy_enabled?: boolean;
}

function createConfig(
  overrides: Partial<AccountLeaseSelectionConfig> = {},
): AccountLeaseSelectionConfig {
  return {
    quotaAwareSchedulingEnabled: true,
    parityEnabled: false,
    parityShadowEnabled: false,
    schedulingMode: 'balance',
    accountSelectionStrategy: 'balanced',
    maxWaitMs: 0,
    noGoMismatchRateThreshold: 0.15,
    noGoErrorRateThreshold: 0.4,
    ...overrides,
  };
}

function createRequest(
  overrides: Partial<AccountLeaseSelectionRequest<TestToken>> = {},
): AccountLeaseSelectionRequest<TestToken> {
  return {
    allTokens: [
      ['acc-1', { email: 'one@example.com' }],
      ['acc-2', { email: 'two@example.com' }],
    ],
    now: Date.now(),
    accountCooldowns: new Map(),
    rateLimitTracker: {
      isRateLimited: vi.fn().mockReturnValue(false),
      getRemainingWaitSeconds: vi.fn().mockReturnValue(0),
    },
    config: createConfig(),
    logger: {
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  };
}

describe('AccountLeaseSelectionPolicy', () => {
  it.each([false, true])(
    'cache-first only waits for a sticky account still in the eligible request pool (excluded=%s)',
    async (excluded) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      try {
        const policy = new AccountLeaseSelectionPolicy();
        policy.bindSession('session', 'acc-1', 60_000);
        const request = createRequest({
          sessionKey: 'session',
          config: createConfig({
            parityEnabled: true,
            schedulingMode: 'cache-first',
            maxWaitMs: 10_000,
          }),
          rateLimitTracker: {
            isRateLimited: (id) => id === 'acc-1' && Date.now() < 5_000,
            getRemainingWaitSeconds: (id) => (id === 'acc-1' ? 5 : 0),
          },
        });
        if (excluded) {
          request.allTokens = request.allTokens.slice(1);
        }
        const result = policy.selectCandidate(request);
        await vi.runAllTimersAsync();
        expect((await result)?.[0]).toBe(excluded ? 'acc-2' : 'acc-1');
        expect(Date.now()).toBe(excluded ? 0 : 5_000);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([false, true])(
    'keeps one account across independent requests in account-first mode (parity=%s)',
    async (parityEnabled) => {
      const policy = new AccountLeaseSelectionPolicy();
      const request = createRequest({
        model: 'claude-sonnet',
        config: createConfig({ parityEnabled, accountSelectionStrategy: 'account-first' }),
      });
      const selected = [];
      for (let index = 0; index < 4; index++) {
        selected.push(
          (await policy.selectCandidate({ ...request, sessionKey: `session-${index}` }))?.[0],
        );
      }
      expect(selected).toEqual(['acc-1', 'acc-1', 'acc-1', 'acc-1']);
    },
  );

  it('fails over on a cooldown and retains the replacement after the original account recovers', async () => {
    const affinity = new AccountLeaseAffinity();
    const policy = new AccountLeaseSelectionPolicy(affinity);
    const request = createRequest({
      model: 'claude-sonnet',
      config: createConfig({ accountSelectionStrategy: 'account-first' }),
    });
    expect((await policy.selectCandidate(request))?.[0]).toBe('acc-1');
    request.accountCooldowns.set('acc-1', request.now + 30_000);
    expect((await policy.selectCandidate(request))?.[0]).toBe('acc-2');
    const replacement = createAccount('acc-2');
    affinity.prepare(undefined, request.model)(replacement, () => true);
    affinity.commit(replacement);
    request.accountCooldowns.clear();
    expect((await policy.selectCandidate(request))?.[0]).toBe('acc-2');
  });

  it('honors model rate limits, exhausted quotas, excluded accounts, and an empty pool', async () => {
    const policy = new AccountLeaseSelectionPolicy();
    const request = createRequest({
      model: 'claude-sonnet',
      config: createConfig({ accountSelectionStrategy: 'account-first' }),
    });
    expect((await policy.selectCandidate(request))?.[0]).toBe('acc-1');
    expect(
      (
        await policy.selectCandidate({
          ...request,
          rateLimitTracker: {
            isRateLimited: (id) => id === 'acc-1',
            getRemainingWaitSeconds: () => 30,
          },
        })
      )?.[0],
    ).toBe('acc-2');
    expect(
      (
        await policy.selectCandidate({
          ...request,
          getModelQuota: (id) => (id === 'acc-2' ? 0 : 80),
        })
      )?.[0],
    ).toBe('acc-1');
    expect(
      (await policy.selectCandidate({ ...request, allTokens: request.allTokens.slice(1) }))?.[0],
    ).toBe('acc-2');
    expect(await policy.selectCandidate({ ...request, allTokens: [] })).toBeNull();
    expect(await policy.selectCandidate({ ...request, getModelQuota: () => 0 })).toBeNull();
  });

  it('filters disabled accounts and selects only the lowest available priority group', async () => {
    const policy = new AccountLeaseSelectionPolicy();
    const request = createRequest({
      allTokens: [
        ['low-priority', { email: 'low@example.com', proxy_priority: 50 }],
        ['preferred-priority', { email: 'preferred@example.com', proxy_priority: 10 }],
        ['disabled-priority', { email: 'disabled@example.com', proxy_priority: 1, proxy_enabled: false }],
        ['same-priority', { email: 'same@example.com', proxy_priority: 10 }],
      ],
      config: createConfig({ accountSelectionStrategy: 'account-first' }),
    });

    expect((await policy.selectCandidate(request))?.[0]).toBe('preferred-priority');
    expect(
      (
        await policy.selectCandidate({
          ...request,
          config: { ...request.config, preferredAccountId: 'low-priority' },
        })
      )?.[0],
    ).toBe('low-priority');
    expect(
      (await policy.selectCandidate({ ...request, allTokens: request.allTokens.slice(0, 3) }))?.[0],
    ).toBe('preferred-priority');
  });

  it('retains existing conversation bindings and explicit preferred accounts', async () => {
    const policy = new AccountLeaseSelectionPolicy();
    const request = createRequest({
      model: 'claude-sonnet',
      sessionKey: 'existing',
      config: createConfig({ accountSelectionStrategy: 'account-first' }),
    });
    policy.bindSession('existing', 'acc-2', request.now + 30_000);
    expect((await policy.selectCandidate(request))?.[0]).toBe('acc-2');
    expect(
      (
        await policy.selectCandidate({
          ...request,
          config: { ...request.config, preferredAccountId: 'acc-1' },
        })
      )?.[0],
    ).toBe('acc-1');
  });

  it('keeps model preferences separate and clears them on account removal or strategy changes', async () => {
    const affinity = new AccountLeaseAffinity();
    const policy = new AccountLeaseSelectionPolicy(affinity);
    const request = createRequest({
      model: 'claude-sonnet',
      config: createConfig({ accountSelectionStrategy: 'account-first' }),
    });
    const successfulReplacement = async () => {
      await policy.selectCandidate({ ...request, allTokens: request.allTokens.slice(1) });
      const token = createAccount('acc-2');
      affinity.prepare(undefined, request.model)(token, () => true);
      affinity.commit(token);
    };
    await successfulReplacement();
    expect((await policy.selectCandidate({ ...request, model: 'gemini-flash' }))?.[0]).toBe(
      'acc-1',
    );
    expect((await policy.selectCandidate(request))?.[0]).toBe('acc-2');
    policy.clearAccountSessions('acc-2');
    expect((await policy.selectCandidate(request))?.[0]).toBe('acc-1');
    await successfulReplacement();
    await policy.selectCandidate({ ...request, config: createConfig() });
    expect((await policy.selectCandidate(request))?.[0]).toBe('acc-1');
    await successfulReplacement();
    policy.resetSelectionState();
    expect((await policy.selectCandidate(request))?.[0]).toBe('acc-1');
  });

  it('uses preferred account when parity scheduling is enabled', async () => {
    const policy = new AccountLeaseSelectionPolicy();

    const selected = await policy.selectCandidate(
      createRequest({
        config: createConfig({
          parityEnabled: true,
          preferredAccountId: 'acc-2',
        }),
      }),
    );

    expect(selected?.[0]).toBe('acc-2');
  });

  it('blocks parity after a shadow mismatch crosses the no-go threshold', async () => {
    const policy = new AccountLeaseSelectionPolicy();

    const shadowSelected = await policy.selectCandidate(
      createRequest({
        config: createConfig({
          parityShadowEnabled: true,
          preferredAccountId: 'acc-2',
          noGoMismatchRateThreshold: 0,
        }),
      }),
    );
    expect(shadowSelected?.[0]).toBe('acc-1');
    expect(policy.getShadowComparisonCount()).toBe(1);
    expect(policy.isNoGoBlocked()).toBe(true);

    policy.resetSelectionState();
    const blockedSelected = await policy.selectCandidate(
      createRequest({
        config: createConfig({
          parityEnabled: true,
          preferredAccountId: 'acc-2',
        }),
      }),
    );
    expect(blockedSelected?.[0]).toBe('acc-1');
  });

  it('applies model-scoped rate limits in legacy scheduling mode', async () => {
    const policy = new AccountLeaseSelectionPolicy();
    const isRateLimited = vi.fn((accountId: string, model?: string) => {
      expect(model).toBe('gemini-3.1-pro-high');
      return accountId === 'acc-1';
    });

    const selected = await policy.selectCandidate(
      createRequest({
        model: 'gemini-3.1-pro-high',
        rateLimitTracker: {
          isRateLimited,
          getRemainingWaitSeconds: vi.fn().mockReturnValue(30),
        },
      }),
    );

    expect(selected?.[0]).toBe('acc-2');
    expect(isRateLimited).toHaveBeenCalledWith('acc-1', 'gemini-3.1-pro-high');
  });

  it('reads the requested model wait when every account is rate limited', async () => {
    const policy = new AccountLeaseSelectionPolicy();
    const getRemainingWaitSeconds = vi.fn().mockReturnValue(30);

    const selected = await policy.selectCandidate(
      createRequest({
        model: 'gemini-3.1-flash-image',
        rateLimitTracker: {
          isRateLimited: vi.fn().mockReturnValue(true),
          getRemainingWaitSeconds,
        },
      }),
    );

    expect(selected).toBeNull();
    expect(getRemainingWaitSeconds).toHaveBeenCalledWith('acc-1', 'gemini-3.1-flash-image');
    expect(getRemainingWaitSeconds).toHaveBeenCalledWith('acc-2', 'gemini-3.1-flash-image');
  });

  it.each([
    { quotaAware: true, expected: ['acc-1', 'acc-1', 'acc-1', 'acc-2', 'acc-1'] },
    { quotaAware: false, expected: ['acc-1', 'acc-2', 'acc-1', 'acc-2', 'acc-1'] },
  ])(
    'rotates accounts with known positive or unknown quota and skips depleted accounts (weighted=$quotaAware)',
    async ({ quotaAware, expected }) => {
      const policy = new AccountLeaseSelectionPolicy();
      const quotaByAccount = new Map([
        ['acc-0', 0],
        ['acc-1', 90],
      ]);
      const request = createRequest({
        model: 'gemini-3-pro',
        getModelQuota: (accountId) => quotaByAccount.get(accountId),
        config: createConfig({ quotaAwareSchedulingEnabled: quotaAware }),
      });
      request.allTokens.push(['acc-0', { email: 'depleted@example.com' }]);

      const selections = await Promise.all(expected.map(() => policy.selectCandidate(request)));
      expect(selections.map((entry) => entry?.[0])).toEqual(expected);
    },
  );
});
