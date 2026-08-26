import { beforeEach, describe, expect, it } from 'vitest';

import { getConfiguredModelMapping } from '@/modules/config/model-aliases';
import { DEFAULT_APP_CONFIG, type ProxyConfig } from '@/modules/config/types';
import {
  getAllDynamicModels,
  getOpenAICompatibleModels,
} from '@/modules/proxy-gateway/antigravity/ModelMapping';
import { ModelRoutingService } from '@/modules/proxy-gateway/server/shared/services/model-routing.service';
import { setServerConfig } from '@/server/server-config';

/**
 * Routing and the two published catalogs used to read the user's aliases from different places:
 * the router merged both legacy maps, while `GET /v1/models` and Gemini's listing read only
 * `custom_mapping`. They now share `getConfiguredModelMapping`, and these cases pin the two
 * answers that share buys -- an alias is advertised exactly when it routes, and a retired one
 * disappears from both at once.
 */
function proxyConfig(overrides: Partial<ProxyConfig>): ProxyConfig {
  return { ...DEFAULT_APP_CONFIG.proxy, ...overrides };
}

const QUOTA_MODELS = ['gemini-3-pro', 'gemini-3-flash'];

describe('model catalogs and routing agree about aliases', () => {
  beforeEach(() => {
    setServerConfig(DEFAULT_APP_CONFIG.proxy);
  });

  it('advertises an enabled alias on both catalogs and routes it to the same target', () => {
    const config = proxyConfig({
      model_aliases: [{ alias: 'my-fast', target: 'gemini-3-flash', enabled: true }],
    });
    setServerConfig(config);

    const mapping = getConfiguredModelMapping(config);

    expect(getOpenAICompatibleModels(mapping, QUOTA_MODELS)).toContain('my-fast');
    expect(getAllDynamicModels(mapping, QUOTA_MODELS)).toContain('my-fast');
    expect(new ModelRoutingService().resolveModelRoute('my-fast')).toMatchObject({
      resolvedModel: 'gemini-3-flash',
      source: 'configured',
    });
  });

  it('drops a retired alias from both catalogs and stops routing it', () => {
    const config = proxyConfig({
      model_aliases: [{ alias: 'my-fast', target: 'gemini-3-flash', enabled: false }],
    });
    setServerConfig(config);

    const mapping = getConfiguredModelMapping(config);

    expect(getOpenAICompatibleModels(mapping, QUOTA_MODELS)).not.toContain('my-fast');
    expect(getAllDynamicModels(mapping, QUOTA_MODELS)).not.toContain('my-fast');
    // Nothing claims the id any more, so it reaches the upstream unchanged and is journalled.
    expect(new ModelRoutingService().resolveModelRoute('my-fast')).toMatchObject({
      resolvedModel: 'my-fast',
      source: 'miss',
    });
  });

  it('advertises an alias that only the legacy Anthropic map declares', () => {
    // Before the shared projection this was the asymmetry: the router honoured
    // `anthropic_mapping`, both catalogs ignored it, so the alias worked but was invisible.
    const config = proxyConfig({
      anthropic_mapping: { 'my-claude-alias': 'gemini-3-pro' },
    });
    setServerConfig(config);

    const mapping = getConfiguredModelMapping(config);

    expect(getOpenAICompatibleModels(mapping, QUOTA_MODELS)).toContain('my-claude-alias');
    expect(new ModelRoutingService().resolveModelRoute('my-claude-alias')).toMatchObject({
      resolvedModel: 'gemini-3-pro',
      source: 'configured',
    });
  });
});
