import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_APP_CONFIG, type ProxyConfig } from '@/modules/config/types';
import { ModelRoutingService } from '@/server/gateway/shared/services/model-routing.service';
import { setServerConfig } from '../../server/server-config';
import {
  getAnthropicFamilyMappingKey,
  updateDynamicForwardingRules,
} from '@/modules/proxy-gateway/antigravity/ModelMapping';

function createProxyConfig(overrides: Partial<ProxyConfig>): ProxyConfig {
  return {
    ...DEFAULT_APP_CONFIG.proxy,
    ...overrides,
    upstream_proxy: {
      ...DEFAULT_APP_CONFIG.proxy.upstream_proxy,
      ...(overrides.upstream_proxy ?? {}),
    },
  };
}

describe('getAnthropicFamilyMappingKey', () => {
  it('classifies legacy Claude configuration groups centrally', () => {
    expect(getAnthropicFamilyMappingKey('claude-sonnet-4-5-20250929')).toBe('claude-4.5-series');
    expect(getAnthropicFamilyMappingKey('claude-3.5-sonnet')).toBe('claude-3.5-series');
    expect(getAnthropicFamilyMappingKey('claude-sonnet-4-6')).toBe('claude-default');
    expect(getAnthropicFamilyMappingKey('gemini-3-flash')).toBeUndefined();
  });
});

describe('ModelRoutingService', () => {
  afterEach(() => {
    setServerConfig(DEFAULT_APP_CONFIG.proxy);
  });

  it('normalizes Gemini model path prefixes and known Gemini aliases', () => {
    const policy = new ModelRoutingService();

    expect(policy.normalizeGeminiModel('models/gemini-2.5-flash')).toBe('gemini-2.5-flash');
    expect(policy.resolveTargetModel('models/gemini-3-flash-preview')).toBe('gemini-3-flash');
    expect(policy.resolveTargetModel('gemini-3-flash-image')).toBe('gemini-3.1-flash-image');
  });

  it('maps dotted Opus 4.6 aliases to the verified thinking model', () => {
    const policy = new ModelRoutingService();

    expect(policy.resolveTargetModel('claude-opus-4.6')).toBe('claude-opus-4-6-thinking');
    expect(policy.resolveTargetModel('claude-opus-4.6-thinking')).toBe('claude-opus-4-6-thinking');
  });

  it('does not turn another Gemini Pro ID into a retired model', () => {
    const policy = new ModelRoutingService();

    for (const model of ['gemini-3.1-pro-preview', 'gemini-3-pro-high', 'gemini-2.5-pro']) {
      expect(policy.resolveTargetModel(model)).toBe(model);
    }
  });

  it('applies configured wildcard mappings after exact mappings and before defaults', () => {
    setServerConfig(
      createProxyConfig({
        custom_mapping: {
          'custom-*': 'gemini-3-flash',
        },
      }),
    );
    const policy = new ModelRoutingService();

    expect(policy.resolveTargetModel('custom-fast')).toBe('gemini-3-flash');
  });

  it('normalizes path prefixes and known aliases in wildcard targets', () => {
    setServerConfig(
      createProxyConfig({
        model_aliases: [
          {
            alias: 'path-target-*',
            target: 'models/gemini-3-flash-preview',
            enabled: true,
          },
          {
            alias: 'alias-target-*',
            target: 'gemini-3-flash-image',
            enabled: true,
          },
        ],
      }),
    );
    const policy = new ModelRoutingService();

    expect(policy.resolveTargetModel('path-target-example')).toBe('gemini-3-flash');
    expect(policy.resolveTargetModel('alias-target-example')).toBe('gemini-3.1-flash-image');
  });

  it('prefers an exact alias and then the most specific wildcard', () => {
    setServerConfig(
      createProxyConfig({
        custom_mapping: {
          'custom-*': 'gemini-3-flash',
          'custom-fast': 'gemini-3.1-pro-low',
          'custom-fast-*': 'gemini-4-argon-high',
          '*': 'gemini-2.5-flash',
        },
      }),
    );
    const policy = new ModelRoutingService();

    expect(policy.resolveTargetModel('custom-fast')).toBe('gemini-3.1-pro-low');
    expect(policy.resolveTargetModel('custom-fast-preview')).toBe('gemini-4-argon-high');
    expect(policy.resolveTargetModel('custom-other')).toBe('gemini-3-flash');
  });

  it('returns the concrete route match and stable wildcard tie-breaking', () => {
    setServerConfig(
      createProxyConfig({
        model_aliases: [
          { alias: 'tie-a-*', target: 'gemini-3.1-pro-low', enabled: true },
          { alias: 'tie-b-*', target: 'gemini-4-argon-high', enabled: true },
        ],
      }),
    );
    const policy = new ModelRoutingService();

    expect(policy.resolveModelRoute('tie-a-example')).toMatchObject({
      match: 'wildcard',
      resolvedModel: 'gemini-3.1-pro-low',
      source: 'configured',
    });
    expect(policy.resolveModelRoute('tie-b-example')).toMatchObject({
      match: 'wildcard',
      resolvedModel: 'gemini-4-argon-high',
      source: 'configured',
    });
  });

  it('uses a unique case-folded alias but rejects conflicting targets', () => {
    setServerConfig(
      createProxyConfig({
        model_aliases: [{ alias: 'Case-Model', target: 'gemini-3.1-pro-low', enabled: true }],
      }),
    );
    const unique = new ModelRoutingService();

    expect(unique.resolveModelRoute('case-model')).toMatchObject({
      match: 'case-folded-exact',
      resolvedModel: 'gemini-3.1-pro-low',
    });

    setServerConfig(
      createProxyConfig({
        model_aliases: [
          { alias: 'Case-Model', target: 'gemini-4-argon-high', enabled: true },
          { alias: 'case-model', target: 'gemini-4-argon-high', enabled: true },
        ],
      }),
    );
    const sameTarget = new ModelRoutingService();

    expect(sameTarget.resolveModelRoute('CASE-MODEL').resolvedModel).toBe('gemini-4-argon-high');

    setServerConfig(
      createProxyConfig({
        model_aliases: [
          { alias: 'Case-Model', target: 'gemini-3.1-pro-low', enabled: true },
          { alias: 'case-model', target: 'gemini-4-argon-high', enabled: true },
        ],
      }),
    );
    const conflicting = new ModelRoutingService();

    expect(() => conflicting.resolveModelRoute('CASE-MODEL')).toThrow(
      'Ambiguous case-insensitive model aliases for "CASE-MODEL"',
    );
    expect(conflicting.resolveModelRoute('Case-Model').resolvedModel).toBe('gemini-3.1-pro-low');
    expect(conflicting.resolveModelRoute('case-model').resolvedModel).toBe('gemini-4-argon-high');
  });

  it('uses a unique Claude-normalized alias but rejects conflicting targets', () => {
    setServerConfig(
      createProxyConfig({
        model_aliases: [
          {
            alias: 'claude-opus-4.6-custom',
            target: 'gemini-3.1-pro-low',
            enabled: true,
          },
        ],
      }),
    );
    const unique = new ModelRoutingService();

    expect(unique.resolveModelRoute('claude-opus-4-6-custom')).toMatchObject({
      match: 'claude-normalized-exact',
      resolvedModel: 'gemini-3.1-pro-low',
    });

    setServerConfig(
      createProxyConfig({
        model_aliases: [
          {
            alias: 'models/claude-opus-4.6-custom',
            target: 'gemini-3.1-pro-low',
            enabled: true,
          },
          {
            alias: 'anthropic/claude-opus-4-6-custom',
            target: 'gemini-4-argon-high',
            enabled: true,
          },
        ],
      }),
    );
    const conflicting = new ModelRoutingService();

    expect(() => conflicting.resolveModelRoute('claude-opus-4-6-custom')).toThrow(
      'Ambiguous Claude-normalized model aliases',
    );
  });

  it('applies Anthropic family mappings to Claude requests', () => {
    setServerConfig(
      createProxyConfig({
        anthropic_mapping: {
          'claude-default': 'gemini-3-flash',
          'claude-4.5-series': 'gemini-3.1-pro-low',
        },
      }),
    );
    const policy = new ModelRoutingService();

    expect(policy.resolveTargetModel('claude-sonnet-4-6')).toBe('gemini-3-flash');
    expect(policy.resolveTargetModel('claude-sonnet-4-5-20250929')).toBe('gemini-3.1-pro-low');
  });

  it('keeps exact Anthropic mappings ahead of family mappings', () => {
    setServerConfig(
      createProxyConfig({
        anthropic_mapping: {
          'claude-default': 'gemini-3-flash',
          'claude-sonnet-4-6': 'gemini-3.1-pro-low',
        },
      }),
    );
    const policy = new ModelRoutingService();

    expect(policy.resolveTargetModel('claude-sonnet-4-6')).toBe('gemini-3.1-pro-low');
  });

  it('applies dynamic deprecated-model forwarding to quota-provided targets', () => {
    updateDynamicForwardingRules('Gemini-Deprecated-Test', 'gemini-future-test');
    const policy = new ModelRoutingService();

    expect(policy.resolveTargetModel('gemini-deprecated-test')).toBe('gemini-future-test');
  });

  it('adds Claude beta headers only for Claude-compatible models', () => {
    const policy = new ModelRoutingService();

    expect(policy.createModelSpecificHeaders('claude-sonnet-4-5')).toEqual({
      'anthropic-beta':
        'claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14',
    });
    expect(policy.createModelSpecificHeaders('gemini-3-flash')).toEqual({});
    expect(policy.createModelSpecificHeaders(undefined)).toEqual({});
  });

  it('keeps exact configured replacements ahead of retirement but protects retirement from wildcards', () => {
    updateDynamicForwardingRules('d08-retired', 'gemini-4-argon-high');
    const policy = new ModelRoutingService();
    setServerConfig(
      createProxyConfig({
        model_aliases: [
          { alias: 'd08-retired', target: 'gemini-3.1-pro-low', enabled: true },
          { alias: 'd08-*', target: 'gemini-3-flash', enabled: true },
        ],
      }),
    );
    expect(policy.resolveModelRoute('d08-retired')).toEqual({
      requestedModel: 'd08-retired',
      normalizedModel: 'd08-retired',
      resolvedModel: 'gemini-3.1-pro-low',
      source: 'configured',
      match: 'exact',
      matchedRule: { alias: 'd08-retired', target: 'gemini-3.1-pro-low' },
    });
    setServerConfig(
      createProxyConfig({
        model_aliases: [{ alias: 'd08-*', target: 'gemini-3-flash', enabled: true }],
      }),
    );
    expect(policy.resolveModelRoute('d08-retired')).toEqual({
      requestedModel: 'd08-retired',
      normalizedModel: 'd08-retired',
      resolvedModel: 'gemini-4-argon-high',
      source: 'dynamic-legacy',
      match: 'dynamic-forwarding',
    });
  });

  it('routes known Claude context suffixes without advertising a larger context', () => {
    setServerConfig(
      createProxyConfig({
        model_aliases: [{ alias: 'claude-opus-4.6', target: 'claude-sonnet-4-6', enabled: true }],
      }),
    );
    const policy = new ModelRoutingService();
    for (const suffix of ['[1m]', '[200k]', '[128k]']) {
      expect(policy.resolveTargetModel(`claude-opus-4-6${suffix}`)).toBe('claude-sonnet-4-6');
    }
    expect(policy.resolveTargetModel('custom-model[1m]')).toBe('custom-model[1m]');
    setServerConfig(
      createProxyConfig({
        model_aliases: [
          { alias: 'claude-opus-4-6[1m]', target: 'gemini-3.1-pro-low', enabled: true },
          { alias: 'claude-opus-4-6', target: 'claude-sonnet-4-6', enabled: true },
        ],
      }),
    );
    expect(policy.resolveTargetModel('claude-opus-4-6[1m]')).toBe('gemini-3.1-pro-low');
    expect(
      policy.createModelSpecificHeaders('claude-sonnet-4-6', [
        'context-1m-2025-08-07,unknown-client-beta',
        'interleaved-thinking-2025-05-14',
      ]),
    ).toEqual({
      'anthropic-beta':
        'claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14',
    });
  });
});

describe('ModelRoutingService.resolveModelRoute', () => {
  afterEach(() => {
    setServerConfig(DEFAULT_APP_CONFIG.proxy);
  });

  it('labels a model that already is the accepted id as canonical, not a built-in mapping', () => {
    const policy = new ModelRoutingService();

    const resolution = policy.resolveModelRoute('gemini-3-flash');

    expect(resolution).toMatchObject({
      normalizedModel: 'gemini-3-flash',
      requestedModel: 'gemini-3-flash',
      resolvedModel: 'gemini-3-flash',
      source: 'canonical',
    });
  });

  it('labels an alias that changes the id as a built-in mapping', () => {
    const policy = new ModelRoutingService();

    const resolution = policy.resolveModelRoute('claude-opus-4.6');

    expect(resolution).toMatchObject({
      resolvedModel: 'claude-opus-4-6-thinking',
      source: 'built-in',
    });
  });

  it('labels a Gemini-alias-only match as a built-in mapping', () => {
    const policy = new ModelRoutingService();

    const resolution = policy.resolveModelRoute('gemini-3-flash-preview');

    expect(resolution).toMatchObject({
      resolvedModel: 'gemini-3-flash',
      source: 'built-in',
    });
  });

  it('labels a wildcard user mapping as configured', () => {
    setServerConfig(
      createProxyConfig({
        custom_mapping: {
          'custom-*': 'gemini-3-flash',
        },
      }),
    );
    const policy = new ModelRoutingService();

    const resolution = policy.resolveModelRoute('custom-fast');

    expect(resolution).toMatchObject({
      match: 'wildcard',
      matchedRule: { alias: 'custom-*', target: 'gemini-3-flash' },
      resolvedModel: 'gemini-3-flash',
      source: 'configured',
    });
  });

  it('records the configured target while routing its normalized alias', () => {
    setServerConfig(
      createProxyConfig({
        custom_mapping: {
          'custom-*': 'models/gemini-3-flash-preview',
        },
      }),
    );
    const policy = new ModelRoutingService();

    expect(policy.resolveModelRoute('custom-fast')).toMatchObject({
      match: 'wildcard',
      matchedRule: {
        alias: 'custom-*',
        target: 'models/gemini-3-flash-preview',
      },
      resolvedModel: 'gemini-3-flash',
      source: 'configured',
    });
  });

  it('labels an exact user mapping as configured', () => {
    setServerConfig(
      createProxyConfig({
        anthropic_mapping: {
          'claude-legacy-tag': 'gemini-4-argon-high',
        },
      }),
    );
    const policy = new ModelRoutingService();

    const resolution = policy.resolveModelRoute('claude-legacy-tag');

    expect(resolution).toMatchObject({
      match: 'exact',
      matchedRule: { alias: 'claude-legacy-tag', target: 'gemini-4-argon-high' },
      resolvedModel: 'gemini-4-argon-high',
      source: 'configured',
    });
  });

  it('labels dynamic deprecated-model forwarding distinctly from a built-in mapping', () => {
    updateDynamicForwardingRules('Gemini-Deprecated-Policy-Test', 'gemini-future-policy-test');
    const policy = new ModelRoutingService();

    const resolution = policy.resolveModelRoute('gemini-deprecated-policy-test');

    expect(resolution).toMatchObject({
      resolvedModel: 'gemini-future-policy-test',
      source: 'dynamic-legacy',
    });
  });

  it('labels a completely unrecognized model as a miss and passes the client string through', () => {
    const policy = new ModelRoutingService();

    const resolution = policy.resolveModelRoute('totally-unknown-model-xyz');

    expect(resolution).toMatchObject({
      resolvedModel: 'totally-unknown-model-xyz',
      source: 'miss',
    });
  });

  it('keeps resolveTargetModel exactly in sync with resolveModelRoute().resolvedModel', () => {
    setServerConfig(
      createProxyConfig({
        custom_mapping: { 'custom-*': 'gemini-3-flash' },
      }),
    );
    updateDynamicForwardingRules('Gemini-Deprecated-Sync-Test', 'gemini-future-sync-test');
    const policy = new ModelRoutingService();

    const samples = [
      'gemini-3-flash',
      'claude-opus-4.6',
      'gemini-3-flash-preview',
      'custom-fast',
      'gemini-deprecated-sync-test',
      'totally-unknown-model-xyz',
    ];

    for (const sample of samples) {
      expect(policy.resolveTargetModel(sample)).toBe(
        policy.resolveModelRoute(sample).resolvedModel,
      );
    }
  });
});
