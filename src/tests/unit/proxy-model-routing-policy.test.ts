import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_CONFIG, type ProxyConfig } from '@/modules/config/types';
import { ProxyModelRoutingPolicy } from '@/modules/proxy-gateway/server/proxy-model-routing-policy';
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

describe('ProxyModelRoutingPolicy', () => {
  it('normalizes Gemini model path prefixes and known Gemini aliases', () => {
    const policy = new ProxyModelRoutingPolicy();

    expect(policy.normalizeGeminiModel('models/gemini-2.5-flash')).toBe('gemini-2.5-flash');
    expect(policy.resolveTargetModel('models/gemini-3.1-pro-preview')).toBe('gemini-3.1-pro-high');
  });

  it('applies configured wildcard mappings before default model routing', () => {
    setServerConfig(
      createProxyConfig({
        custom_mapping: {
          'custom-*': 'gemini-3-flash',
        },
      }),
    );
    const policy = new ProxyModelRoutingPolicy();

    expect(policy.resolveTargetModel('custom-fast')).toBe('gemini-3-flash');
  });

  it('applies dynamic deprecated-model forwarding to quota-provided targets', () => {
    updateDynamicForwardingRules('Gemini-Deprecated-Test', 'gemini-future-test');
    const policy = new ProxyModelRoutingPolicy();

    expect(policy.resolveTargetModel('gemini-deprecated-test')).toBe('gemini-future-test');
  });

  it('adds Claude beta headers only for Claude-compatible models', () => {
    const policy = new ProxyModelRoutingPolicy();

    expect(policy.createModelSpecificHeaders('claude-sonnet-4-5')).toEqual({
      'anthropic-beta':
        'claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14',
    });
    expect(policy.createModelSpecificHeaders('gemini-3-flash')).toEqual({});
    expect(policy.createModelSpecificHeaders(undefined)).toEqual({});
  });
});
