import { describe, expect, it, vi } from 'vitest';
import {
  AccountLeaseSelectionPolicy,
  type AccountLeaseSelectionConfig,
  type AccountLeaseSelectionRequest,
} from '@/modules/proxy-gateway/server/account-lease-selection-policy';

interface TestToken {
  email: string;
}

function createConfig(
  overrides: Partial<AccountLeaseSelectionConfig> = {},
): AccountLeaseSelectionConfig {
  return {
    parityEnabled: false,
    parityShadowEnabled: false,
    schedulingMode: 'balance',
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
});
