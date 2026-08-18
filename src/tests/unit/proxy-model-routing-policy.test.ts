import { describe, expect, it } from 'vitest';
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

  it('applies configured Anthropic family mappings', () => {
    setServerConfig(
      createProxyConfig({
        anthropic_mapping: {
          'claude-4.5-series': 'gemini-3-flash',
          'claude-default': 'gemini-3.1-pro-high',
        },
      }),
    );
    const policy = new ModelRoutingService();

    expect(policy.resolveTargetModel('claude-sonnet-4-5-20250929')).toBe('gemini-3-flash');
    expect(policy.resolveTargetModel('claude-sonnet-4-6')).toBe('gemini-3.1-pro-high');
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
