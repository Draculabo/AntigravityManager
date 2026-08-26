import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_APP_CONFIG, type ProxyConfig } from '@/modules/config/types';
import { ModelRoutingService } from '@/modules/proxy-gateway/server/shared/services/model-routing.service';
import { setServerConfig } from '../../server/server-config';
import { updateDynamicForwardingRules } from '@/modules/proxy-gateway/antigravity/ModelMapping';

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

describe('ModelRoutingService', () => {
  afterEach(() => {
    setServerConfig(DEFAULT_APP_CONFIG.proxy);
  });

  it('normalizes Gemini model path prefixes and known Gemini aliases', () => {
    const policy = new ModelRoutingService();

    expect(policy.normalizeGeminiModel('models/gemini-2.5-flash')).toBe('gemini-2.5-flash');
    expect(policy.resolveTargetModel('models/gemini-3.1-pro-preview')).toBe('gemini-3.1-pro-high');
    expect(policy.resolveTargetModel('gemini-3-flash-image')).toBe('gemini-3.1-flash-image');
  });

  it('maps dotted Opus 4.6 aliases to the verified thinking model', () => {
    const policy = new ModelRoutingService();

    expect(policy.resolveTargetModel('claude-opus-4.6')).toBe('claude-opus-4-6-thinking');
    expect(policy.resolveTargetModel('claude-opus-4.6-thinking')).toBe('claude-opus-4-6-thinking');
  });

  it('routes Gemini Pro high presets through the upstream agent model', () => {
    const policy = new ModelRoutingService();

    expect(policy.resolveTargetModel('gemini-3.1-pro-high')).toBe('gemini-pro-agent');
    expect(policy.resolveTargetModel('gemini-3-pro-high')).toBe('gemini-pro-agent');
    expect(policy.resolveTargetModel('gemini-pro-agent')).toBe('gemini-pro-agent');
  });

  it('applies configured wildcard mappings before default model routing', () => {
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
      resolvedModel: 'gemini-3-flash',
      source: 'configured',
    });
  });

  it('labels an exact user mapping as configured', () => {
    setServerConfig(
      createProxyConfig({
        anthropic_mapping: {
          'claude-legacy-tag': 'gemini-3.1-pro-high',
        },
      }),
    );
    const policy = new ModelRoutingService();

    const resolution = policy.resolveModelRoute('claude-legacy-tag');

    expect(resolution).toMatchObject({
      resolvedModel: 'gemini-3.1-pro-high',
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
