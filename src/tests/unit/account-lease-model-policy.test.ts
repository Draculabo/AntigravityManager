import { ModelAvailabilityService } from '@/server/gateway/shared/services/model-availability.service';
import { describe, expect, it, vi } from 'vitest';
import { AccountLeaseModelPolicy } from '@/server/gateway/modules/account-lease/policies/account-lease-model.policy';
import type { AccountLeaseTokenData } from '@/server/gateway/modules/account-lease/interfaces/account-lease-token-types';

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
  const availability = new ModelAvailabilityService();
  const policy = new AccountLeaseModelPolicy({
    isModelBlocked: (accountId, model) => availability.isCapabilityBlocked(accountId, model),
    getTokenCache: () => tokenCache,
    logger,
  });

  return {
    logger,
    policy,
    availability,
  };
}

describe('AccountLeaseModelPolicy', () => {
  it('excludes stale Pro High entries and forwarding targets from account binding', () => {
    const { policy } = createPolicy(
      new Map([
        [
          'current',
          createToken({
            account_id: 'current',
            model_quotas: { 'gemini-3.1-pro-high': 100, 'gemini-pro-agent': 100 },
            model_forwarding_rules: { 'gemini-3.1-pro': 'gemini-3.1-pro-high' },
          }),
        ],
        [
          'legacy',
          createToken({ account_id: 'legacy', model_quotas: { 'gemini-pro-agent': 100 } }),
        ],
        ['low', createToken({ account_id: 'low', model_quotas: { 'gemini-3.1-pro-low': 100 } })],
      ]),
    );
    expect([
      policy.getModelAvailabilityForAccount('current', 'gemini-3.1-pro'),
      policy.getExactModelAvailabilityForAccount('current', 'gemini-3.1-pro-high'),
      policy.getModelAvailabilityForAccount('legacy', 'gemini-pro-agent'),
      policy.getModelAvailabilityForAccount('low', 'gemini-3.1-pro-low'),
    ]).toEqual(['unavailable', 'unavailable', 'unavailable', 'available']);
  });

  it('publishes only capabilities that agree across eligible accounts', () => {
    const token = createToken({
      quota: {
        models: {
          'gemini-3.1-pro-low': {
            percentage: 100,
            resetTime: '',
            supports_images: true,
            supports_thinking: true,
            max_output_tokens: 8192,
          },
        },
      },
    });
    const cache = new Map([['acc-1', token]]);
    const { policy } = createPolicy(cache);
    expect(policy.getModelDiscoveryCapabilities('gemini-3.1-pro-low', true)).toEqual({
      supports_images: true,
      supports_thinking: true,
      max_output_tokens: 8192,
    });
    cache.set(
      'second',
      createToken({
        account_id: 'second',
        quota: {
          models: {
            'gemini-3.1-pro-low': {
              percentage: 100,
              resetTime: '',
              supports_images: false,
              supports_thinking: true,
              max_output_tokens: 4096,
            },
          },
        },
      }),
    );
    expect(policy.getModelDiscoveryCapabilities('gemini-3.1-pro-low', true)).toEqual({
      supports_thinking: true,
    });
    cache.set('unknown', createToken({ account_id: 'unknown' }));
    expect(policy.getModelDiscoveryCapabilities('gemini-3.1-pro-low', true)).toEqual({});
  });

  it('does not substitute automatic Flash for an unavailable explicit fixed High profile', () => {
    const { policy } = createPolicy(
      new Map([['acc-1', createToken({ model_quotas: { 'gemini-3.7-flash-tiered': 100 } })]]),
    );
    expect(policy.getModelAvailabilityForAccount('acc-1', 'gemini-3.7-flash-high')).toBe(
      'unavailable',
    );
    expect(policy.resolveDynamicModelForAccount('acc-1', 'gemini-3.7-flash-high')).toBe(
      'gemini-3.7-flash-high',
    );
    expect(policy.getModelAvailabilityForAccount('acc-1', 'gemini-3.8-flash-high')).toBe(
      'unavailable',
    );
  });

  it('selects bare family tiers in the confirmed default order', () => {
    const cases = [
      {
        available: ['gemini-3.8-flash-high', 'gemini-3.8-flash-low'],
        expected: 'gemini-3.8-flash-high',
      },
      {
        available: ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low'],
        expected: 'gemini-3.8-flash-medium',
      },
      {
        available: ['gemini-3.8-flash-tiered', 'gemini-3.8-flash-medium'],
        expected: 'gemini-3.8-flash-tiered',
      },
      {
        available: ['gemini-3.8-flash-extra-low', 'gemini-3.8-flash-low'],
        expected: 'gemini-3.8-flash-low',
      },
      {
        available: ['gemini-3.8-flash-extra-low'],
        expected: 'gemini-3.8-flash-extra-low',
      },
    ] as const;

    for (const testCase of cases) {
      const { policy } = createPolicy(
        new Map([
          [
            'acc-1',
            createToken({
              model_quotas: Object.fromEntries(testCase.available.map((model) => [model, 80])),
            }),
          ],
        ]),
      );
      expect(policy.resolveBareModelForAccount('acc-1', 'gemini-3.8-flash')).toBe(
        testCase.expected,
      );
    }
  });

  it('normalizes bare-model effort aliases and chooses the closest real tier', () => {
    const { policy } = createPolicy(
      new Map([
        [
          'acc-1',
          createToken({
            model_quotas: {
              'gemini-3.8-flash-high': 80,
              'gemini-3.8-flash-low': 80,
            },
          }),
        ],
      ]),
    );

    expect(policy.parseBareModelEffort('extra_low')).toBe('extra-low');
    expect(policy.parseBareModelEffort(' MIN ')).toBe('extra-low');
    expect(policy.parseBareModelEffort('minimal')).toBe('extra-low');
    expect(policy.parseBareModelEffort('lite')).toBe('extra-low');
    expect(policy.parseBareModelEffort('X_HIGH')).toBe('high');
    expect(policy.parseBareModelEffort('xhigh')).toBe('high');
    expect(policy.parseBareModelEffort('max')).toBe('high');
    expect(policy.parseBareModelEffort('extreme')).toBe('high');
    expect(policy.parseBareModelEffort('not-a-tier')).toBeNull();
    expect(policy.resolveBareModelForAccount('acc-1', 'gemini-3.8-flash', 'extra_low')).toBe(
      'gemini-3.8-flash-low',
    );
    expect(policy.resolveBareModelForAccount('acc-1', 'gemini-3.8-flash', 'x_high')).toBe(
      'gemini-3.8-flash-high',
    );
    expect(policy.resolveBareModelForAccount('acc-1', 'gemini-3.8-flash', 'not-a-tier')).toBeNull();
  });

  it('rejects an unknown effort before availability or model selection', () => {
    const { policy } = createPolicy(
      new Map([
        [
          'acc-1',
          createToken({
            model_quotas: {
              'gemini-3.8-flash-high': 80,
            },
          }),
        ],
      ]),
    );

    expect(() =>
      policy.getExactModelAvailabilityForAccount('acc-1', 'gemini-3.8-flash', 'not-a-tier'),
    ).toThrow('Unsupported model effort "not-a-tier"');
    expect(() =>
      policy.getModelAvailabilityForAccount('acc-1', 'gemini-3.8-flash', 'not-a-tier'),
    ).toThrow('Unsupported model effort "not-a-tier"');
    expect(() =>
      policy.resolveDynamicModelForAccount('acc-1', 'gemini-3.8-flash', 'not-a-tier'),
    ).toThrow('Unsupported model effort "not-a-tier"');
  });

  it('selects the bare Pro tier before preview fallback candidates', () => {
    const { policy } = createPolicy(
      new Map([
        [
          'acc-1',
          createToken({
            model_quotas: {
              'gemini-3.1-pro-preview': 80,
              'gemini-3.1-pro-low': 80,
            },
          }),
        ],
      ]),
    );

    expect(policy.resolveDynamicModelForAccount('acc-1', 'gemini-3.1-pro')).toBe(
      'gemini-3.1-pro-low',
    );
  });

  it('does not rewrite an explicit tier through the bare-model selector', () => {
    const { policy } = createPolicy(
      new Map([
        [
          'acc-1',
          createToken({
            model_quotas: {
              'gemini-3.8-flash-high': 80,
              'gemini-3.8-flash-medium': 80,
            },
          }),
        ],
      ]),
    );

    expect(policy.resolveBareModelForAccount('acc-1', 'gemini-3.8-flash-low', 'high')).toBeNull();
  });
  describe('output limit precedence', () => {
    // Rule: provider `ModelDetails` from the quota payload wins, persisted `model_limits`
    // is the compatibility layer beneath it, and static specs stay the last resort in
    // `GenerationConstraintsService`.
    it('prefers the provider cap over persisted compatibility data', () => {
      const tokenCache = new Map([
        [
          'acc-1',
          createToken({
            model_limits: { 'gemini-3-flash': 8192 },
            quota: {
              models: {
                'gemini-3-flash': {
                  percentage: 100,
                  resetTime: '',
                  max_output_tokens: 65536,
                },
              },
            },
          }),
        ],
      ]);
      const { policy } = createPolicy(tokenCache);

      expect(policy.getModelOutputLimitForAccount('acc-1', 'gemini-3-flash')).toBe(65536);
    });

    it('falls back to persisted data when the provider declares no cap', () => {
      const tokenCache = new Map([
        [
          'acc-1',
          createToken({
            model_limits: { 'gemini-3-flash': 8192 },
            quota: {
              models: {
                'gemini-3-flash': { percentage: 100, resetTime: '' },
              },
            },
          }),
        ],
      ]);
      const { policy } = createPolicy(tokenCache);

      expect(policy.getModelOutputLimitForAccount('acc-1', 'gemini-3-flash')).toBe(8192);
    });

    it('ignores a non-positive provider cap rather than trusting it', () => {
      const tokenCache = new Map([
        [
          'acc-1',
          createToken({
            model_limits: { 'gemini-3-flash': 8192 },
            quota: {
              models: {
                'gemini-3-flash': { percentage: 100, resetTime: '', max_output_tokens: 0 },
              },
            },
          }),
        ],
      ]);
      const { policy } = createPolicy(tokenCache);

      expect(policy.getModelOutputLimitForAccount('acc-1', 'gemini-3-flash')).toBe(8192);
    });
  });

  it('distinguishes an exact model from a compatible family fallback', () => {
    const tokenCache = new Map([
      [
        'exact',
        createToken({
          model_quotas: {
            'gemini-3.1-pro-low': 80,
          },
        }),
      ],
      [
        'fallback',
        createToken({
          model_quotas: {
            'gemini-pro-agent': 80,
          },
        }),
      ],
    ]);
    const { policy } = createPolicy(tokenCache);

    expect([
      policy.getExactModelAvailabilityForAccount('exact', 'gemini-3.1-pro-low'),
      policy.getExactModelAvailabilityForAccount('fallback', 'gemini-3.1-pro-low'),
    ]).toEqual(['available', 'unavailable']);
  });

  it('rejects an unregistered same-family preview as a physical fallback', () => {
    const tokenCache = new Map([
      [
        'acc-1',
        createToken({
          model_quotas: {
            'gemini-3.1-pro-preview': 80,
          },
        }),
      ],
    ]);
    const { policy } = createPolicy(tokenCache);

    expect(policy.getModelAvailabilityForAccount('acc-1', 'gemini-3.1-pro-low')).toBe(
      'unavailable',
    );
    expect(policy.resolveDynamicModelForAccount('acc-1', 'gemini-3.1-pro-low')).toBe(
      'gemini-3.1-pro-low',
    );
  });

  it('preserves the complete tier profile when a registered sibling is available', () => {
    const tokenCache = new Map([
      [
        'acc-1',
        createToken({
          model_quotas: {
            'gemini-3.7-flash-medium': 80,
          },
        }),
      ],
    ]);
    const { policy } = createPolicy(tokenCache);

    expect(policy.getModelAvailabilityForAccount('acc-1', 'gemini-3.7-flash-low')).toBe(
      'unavailable',
    );
    expect(policy.resolveDynamicModelForAccount('acc-1', 'gemini-3.7-flash-low')).toBe(
      'gemini-3.7-flash-low',
    );
    expect(policy.resolveDynamicModelForAccount('acc-1', 'gemini-3.7-flash-high')).toBe(
      'gemini-3.7-flash-high',
    );
  });

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

  it('collects raw physical quota IDs from every loaded account without display aliases', () => {
    const tokenCache = new Map([
      [
        'acc-1',
        createToken({
          model_quotas: {
            'gemini-3-flash-agent': 80,
            'gemini-3-pro-image': 80,
          },
          quota: {
            models: {
              'gemini-3-flash-agent': {
                percentage: 80,
                resetTime: '',
                display_name: 'Gemini 3.5 Flash (High)',
              },
            },
          },
        }),
      ],
      [
        'acc-2',
        createToken({
          account_id: 'acc-2',
          model_quotas: {
            'gemini-pro-agent': 80,
          },
        }),
      ],
    ]);
    const { policy } = createPolicy(tokenCache);

    expect(policy.getAllRawQuotaModels()).toEqual(
      new Set(['gemini-3-flash-agent', 'gemini-3-pro-image', 'gemini-pro-agent']),
    );
  });

  it('retains source-aware positive model evidence per account', () => {
    const token = createToken({
      model_quotas: {
        'gemini-3-flash-agent': 80,
        'gemini-3-pro-image': 80,
      },
      quota: {
        models: {
          'models/gemini-3-flash-agent': {
            percentage: 80,
            resetTime: '',
            display_name: 'Gemini 3.5 Flash (High)',
            max_output_tokens: 32768,
          },
          'claude-sonnet-4-6': {
            percentage: 80,
            resetTime: '',
            supports_thinking: true,
          },
        },
      },
    });
    const { policy } = createPolicy(new Map([['acc-1', token]]));

    expect(policy.getPositiveModelEvidenceFromToken(token)).toEqual([
      {
        modelId: 'claude-sonnet-4-6',
        source: 'provider-catalog',
        details: { supportsThinking: true },
      },
      {
        modelId: 'gemini-3-flash-agent',
        source: 'provider-catalog',
        displayName: 'Gemini 3.5 Flash (High)',
        details: {
          maxOutputTokens: 32768,
        },
      },
      {
        modelId: 'gemini-3-pro-image',
        source: 'quota-snapshot',
      },
    ]);
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
            'gemini-3-flash-agent': 80,
          },
        }),
      ],
    ]);
    const { policy } = createPolicy(tokenCache);

    expect(policy.getModelAvailabilityForAccount('acc-1', 'gemini-3-flash-agent')).toBe(
      'available',
    );
    expect(policy.getModelAvailabilityForAccount('acc-1', 'gpt-oss-120b-medium')).toBe(
      'unavailable',
    );
    expect(policy.getModelAvailabilityForAccount('missing', 'gemini-3-flash')).toBe('unknown');
  });

  it('keeps the registered Gemini Pro suffix instead of an unregistered preview', () => {
    const tokenCache = new Map([
      [
        'acc-1',
        createToken({
          model_quotas: {
            'gemini-3.1-pro-preview': 80,
            'gemini-3.1-pro-low': 80,
          },
        }),
      ],
    ]);
    const { policy } = createPolicy(tokenCache);

    expect(policy.resolveDynamicModelForAccount('acc-1', 'gemini-3.1-pro-low')).toBe(
      'gemini-3.1-pro-low',
    );
  });

  it('rewrites image models only within their requested quality tier', () => {
    const tokenCache = new Map([
      [
        'acc-1',
        createToken({
          model_quotas: {
            'gemini-3.1-pro-image': 80,
            'gemini-3.1-flash-image': 80,
          },
        }),
      ],
    ]);
    const { policy } = createPolicy(tokenCache);

    expect(policy.resolveDynamicModelForAccount('acc-1', 'gemini-3-pro-image')).toBe(
      'gemini-3.1-pro-image',
    );
    expect(policy.resolveDynamicModelForAccount('acc-1', 'gemini-3-flash-image')).toBe(
      'gemini-3.1-flash-image',
    );
  });

  it('keeps the requested image model when that exact version is available', () => {
    const tokenCache = new Map([
      [
        'acc-1',
        createToken({
          model_quotas: {
            'gemini-3-pro-image': 80,
            'gemini-3.1-pro-image': 80,
          },
        }),
      ],
    ]);
    const { policy } = createPolicy(tokenCache);

    expect(policy.resolveDynamicModelForAccount('acc-1', 'gemini-3-pro-image')).toBe(
      'gemini-3-pro-image',
    );
  });

  it('does not silently downgrade a Pro image request to Flash', () => {
    const tokenCache = new Map([
      [
        'acc-1',
        createToken({
          model_quotas: {
            'gemini-3.1-flash-image': 80,
          },
        }),
      ],
    ]);
    const { policy } = createPolicy(tokenCache);

    expect(policy.resolveDynamicModelForAccount('acc-1', 'gemini-3-pro-image')).toBe(
      'gemini-3-pro-image',
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

  it('keeps a capability-denied family from rerouting to another physical tier', () => {
    const tokenCache = new Map([
      [
        'acc-1',
        createToken({
          model_quotas: {
            'gemini-3.6-flash-low': 80,
            'gemini-3.6-flash-medium': 80,
            'gemini-3.6-flash-tiered': 80,
            'gemini-3.5-flash-low': 80,
          },
        }),
      ],
    ]);
    const { logger, policy, availability } = createPolicy(tokenCache);

    expect(policy.resolveDynamicModelForAccount('acc-1', 'gemini-3.6-flash-low')).toBe(
      'gemini-3.6-flash-low',
    );

    availability.mark('acc-1', 'gemini-3.6-flash-low', 'model_not_supported');

    expect(policy.resolveDynamicModelForAccount('acc-1', 'gemini-3.6-flash-low')).toBe(
      'gemini-3.6-flash-low',
    );
    expect(logger.log).not.toHaveBeenCalledWith(
      expect.stringContaining('[Unrequestable-Model-Rewrite]'),
    );
  });

  it('skips unrequestable siblings and stays cross-family safe', () => {
    const tokenCache = new Map([
      [
        'acc-1',
        createToken({
          model_quotas: {
            'gemini-3.6-flash-low': 80,
            'gemini-3.6-flash-medium': 80,
            'gemini-3.5-flash-high': 80,
          },
        }),
      ],
    ]);
    const { policy, availability } = createPolicy(tokenCache);

    availability.mark('acc-1', 'gemini-3.6-flash-low', 'model_not_supported');
    availability.mark('acc-1', 'gemini-3.6-flash-medium', 'model_not_supported');

    // Both 3.6 variants are rejected and 3.5 belongs to another family base,
    // so the requested id passes through unchanged.
    expect(policy.resolveDynamicModelForAccount('acc-1', 'gemini-3.6-flash-low')).toBe(
      'gemini-3.6-flash-low',
    );
  });

  it('never reroutes to a sibling only advertised by a different account', () => {
    const tokenCache = new Map([
      [
        'acc-1',
        createToken({
          model_quotas: {
            'gemini-3.6-flash-low': 80,
          },
        }),
      ],
      [
        'acc-2',
        createToken({
          account_id: 'acc-2',
          model_quotas: {
            'gemini-3.6-flash-tiered': 80,
          },
        }),
      ],
    ]);
    const { policy, availability } = createPolicy(tokenCache);

    availability.mark('acc-1', 'gemini-3.6-flash-low', 'model_not_supported');

    // acc-1 does not advertise the tiered sibling itself, so it must not be
    // rewritten to a model that only acc-2 can serve.
    expect(policy.resolveDynamicModelForAccount('acc-1', 'gemini-3.6-flash-low')).toBe(
      'gemini-3.6-flash-low',
    );
    expect(policy.resolveDynamicModelForAccount('acc-2', 'gemini-3.6-flash-low')).toBe(
      'gemini-3.6-flash-low',
    );
    expect(policy.getModelAvailabilityForAccount('acc-2', 'gemini-3.6-flash-low')).toBe(
      'unavailable',
    );
  });

  it('never selects an unrequestable model through fallback candidate paths', () => {
    const tokenCache = new Map([
      [
        'acc-1',
        createToken({
          model_quotas: {
            'gemini-3.1-pro-preview': 80,
            'gemini-3.1-pro-low': 80,
          },
        }),
      ],
    ]);
    const { policy, availability } = createPolicy(tokenCache);

    // The pro-candidate chain prefers the preview id; once upstream rejects
    // it, fallback selection must skip it instead of re-serving it.
    expect(policy.resolveDynamicModelForAccount('acc-1', 'gemini-3-pro')).toBe(
      'gemini-3.1-pro-preview',
    );

    availability.mark('acc-1', 'gemini-3.1-pro-preview', 'model_not_supported');

    expect(policy.resolveDynamicModelForAccount('acc-1', 'gemini-3-pro')).toBe('gemini-3-pro');
  });

  it('keeps unknown models untouched when marked unrequestable without siblings', () => {
    const tokenCache = new Map([['acc-1', createToken()]]);
    const { policy, availability } = createPolicy(tokenCache);

    availability.mark('acc-1', 'claude-opus-4-6-thinking', 'model_not_supported');

    expect(policy.resolveDynamicModelForAccount('acc-1', 'claude-opus-4-6-thinking')).toBe(
      'claude-opus-4-6-thinking',
    );
  });

  it('resolves gemini-4-argon and gemini-4-argon-high to available Argon models', () => {
    const tokenCache = new Map([
      ['acc-1', createToken({ model_quotas: { 'gemini-4-argon-high': 100 } })],
    ]);
    const { policy } = createPolicy(tokenCache);

    expect(policy.getModelAvailabilityForAccount('acc-1', 'gemini-4-argon')).toBe('available');
    expect(policy.resolveDynamicModelForAccount('acc-1', 'gemini-4-argon')).toBe(
      'gemini-4-argon-high',
    );
    expect(policy.getModelAvailabilityForAccount('acc-1', 'gemini-4-argon-high')).toBe('available');
    expect(policy.resolveDynamicModelForAccount('acc-1', 'gemini-4-argon-high')).toBe(
      'gemini-4-argon-high',
    );
    expect(policy.getModelAvailabilityForAccount('acc-1', 'gemini-4-argon-low')).toBe(
      'unavailable',
    );
    expect(policy.resolveDynamicModelForAccount('acc-1', 'gemini-4-argon-low')).toBe(
      'gemini-4-argon-low',
    );
  });
});
