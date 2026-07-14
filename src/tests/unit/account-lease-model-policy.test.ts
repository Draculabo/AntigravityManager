import { describe, expect, it, vi } from 'vitest';
import { AccountLeaseModelPolicy } from '@/modules/proxy-gateway/server/account-lease-model-policy';
import type { AccountLeaseTokenData } from '@/modules/proxy-gateway/server/account-lease-token-types';

function createToken(overrides: Partial<AccountLeaseTokenData> = {}): AccountLeaseTokenData {
  return {
    account_id: 'acc-1',
    email: 'lease@example.com',
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    token_type: 'Bearer',
    expires_in: 3600,
    expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
    model_quotas: {},
    model_limits: {},
    model_reset_times: {},
    model_forwarding_rules: {},
    ...overrides,
  };
}

function createPolicy(tokenCache: Map<string, AccountLeaseTokenData>) {
  const logger = {
    log: vi.fn(),
  };
  const policy = new AccountLeaseModelPolicy({
    getTokenCache: () => tokenCache,
    logger,
  });

  return {
    logger,
    policy,
  };
}

describe('AccountLeaseModelPolicy', () => {
  it('rewrites gemini pro requests to the first available account candidate', () => {
    const tokenCache = new Map([
      [
        'acc-1',
        createToken({
          model_quotas: {
            'gemini-3.1-pro-low': 80,
          },
        }),
      ],
    ]);
    const { logger, policy } = createPolicy(tokenCache);

    const resolved = policy.resolveDynamicModelForAccount('acc-1', 'gemini-3-pro');

    expect(resolved).toBe('gemini-3.1-pro-low');
    expect(logger.log).toHaveBeenCalledWith(
      '[Dynamic-Model-Rewrite] account=acc-1 gemini-3-pro -> gemini-3.1-pro-low',
    );
  });

  it('keeps original model when dynamic rewrite is not applicable', () => {
    const tokenCache = new Map([['acc-1', createToken()]]);
    const { policy } = createPolicy(tokenCache);

    expect(policy.resolveDynamicModelForAccount('acc-1', 'gemini-3-flash')).toBe('gemini-3-flash');
  });

  it('uses quota forwarding rules before family candidates', () => {
    const tokenCache = new Map([
      [
        'acc-1',
        createToken({
          model_quotas: {
            'gemini-3.5-flash-extra-low': 80,
          },
          model_forwarding_rules: {
            'gemini-3.5-flash-high': 'gemini-3.5-flash-extra-low',
          },
        }),
      ],
    ]);
    const { logger, policy } = createPolicy(tokenCache);

    const resolved = policy.resolveDynamicModelForAccount('acc-1', 'gemini-3.5-flash-high');

    expect(resolved).toBe('gemini-3.5-flash-extra-low');
    expect(logger.log).toHaveBeenCalledWith(
      '[Dynamic-Model-Rewrite] account=acc-1 gemini-3.5-flash-high -> gemini-3.5-flash-extra-low',
    );
  });

  it('routes Antigravity display presets to their real upstream model IDs', () => {
    const tokenCache = new Map([
      [
        'acc-1',
        createToken({
          model_quotas: {
            'gemini-3-flash-agent': 80,
            'gemini-3.5-flash-low': 80,
            'gemini-3.5-flash-extra-low': 80,
            'claude-sonnet-4-6': 80,
          },
          quota: {
            models: {
              'gemini-3-flash-agent': {
                percentage: 80,
                resetTime: '',
                display_name: 'Gemini 3.5 Flash (High)',
              },
              'gemini-3.5-flash-low': {
                percentage: 80,
                resetTime: '',
                display_name: 'Gemini 3.5 Flash (Medium)',
              },
              'gemini-3.5-flash-extra-low': {
                percentage: 80,
                resetTime: '',
                display_name: 'Gemini 3.5 Flash (Low)',
              },
              'claude-sonnet-4-6': {
                percentage: 80,
                resetTime: '',
                display_name: 'Claude Sonnet 4.6 (Thinking)',
              },
            },
          },
        }),
      ],
    ]);
    const { logger, policy } = createPolicy(tokenCache);

    expect(policy.resolveDynamicModelForAccount('acc-1', 'gemini-3.5-flash-high')).toBe(
      'gemini-3-flash-agent',
    );
    expect(policy.resolveDynamicModelForAccount('acc-1', 'gemini-3.5-flash-medium')).toBe(
      'gemini-3.5-flash-low',
    );
    expect(policy.resolveDynamicModelForAccount('acc-1', 'gemini-3.5-flash-low')).toBe(
      'gemini-3.5-flash-extra-low',
    );
    expect(policy.resolveDynamicModelForAccount('acc-1', 'claude-sonnet-4-6-thinking')).toBe(
      'claude-sonnet-4-6',
    );
    expect(policy.getModelAvailabilityForAccount('acc-1', 'gemini-3.5-flash-high')).toBe(
      'available',
    );
    expect(policy.getAllCollectedModels()).toEqual(
      new Set([
        'gemini-3.5-flash-high',
        'gemini-3.5-flash-medium',
        'gemini-3.5-flash-low',
        'claude-sonnet-4-6-thinking',
      ]),
    );
    expect(logger.log).toHaveBeenCalledWith(
      '[Dynamic-Model-Rewrite] account=acc-1 gemini-3.5-flash-high -> gemini-3-flash-agent',
    );
  });

  it('reports whether an account can actually serve a dynamically listed model', () => {
    const tokenCache = new Map([
      [
        'acc-1',
        createToken({
          model_quotas: {
            'gemini-3-flash': 80,
          },
        }),
      ],
    ]);
    const { policy } = createPolicy(tokenCache);

    expect(policy.getModelAvailabilityForAccount('acc-1', 'gemini-3-flash')).toBe('available');
    expect(policy.getModelAvailabilityForAccount('acc-1', 'gpt-oss-120b-medium')).toBe(
      'unavailable',
    );
    expect(policy.getModelAvailabilityForAccount('missing', 'gemini-3-flash')).toBe('unknown');
  });

  it('keeps Gemini Pro preview preference ahead of a rejected high suffix', () => {
    const tokenCache = new Map([
      [
        'acc-1',
        createToken({
          model_quotas: {
            'gemini-3.1-pro-preview': 80,
            'gemini-3.1-pro-high': 80,
          },
        }),
      ],
    ]);
    const { policy } = createPolicy(tokenCache);

    expect(policy.resolveDynamicModelForAccount('acc-1', 'gemini-3.1-pro-high')).toBe(
      'gemini-3.1-pro-preview',
    );
  });

  it('reads output limits and thinking budgets from token quota state', () => {
    const tokenCache = new Map([
      [
        'acc-1',
        createToken({
          model_limits: {
            'gemini-3-pro': 8192,
          },
          quota: {
            models: {
              'models/gemini-3-pro': {
                percentage: 100,
                resetTime: '2026-06-20T00:00:00.000Z',
                thinking_budget: 32768.8,
              },
            },
          },
        }),
      ],
    ]);
    const { policy } = createPolicy(tokenCache);

    expect(policy.getModelOutputLimitForAccount('acc-1', 'models/gemini-3-pro')).toBe(8192);
    expect(policy.getModelThinkingBudgetForAccount('acc-1', 'gemini-3-pro')).toBe(32768);
  });
});
