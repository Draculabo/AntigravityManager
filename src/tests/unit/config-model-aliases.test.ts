import { describe, expect, it } from 'vitest';

import {
  getConfiguredModelMapping,
  migrateLegacyModelAliases,
} from '@/modules/config/model-aliases';
import { DEFAULT_APP_CONFIG, type ProxyConfig } from '@/modules/config/types';

function proxyConfig(overrides: Partial<ProxyConfig>): ProxyConfig {
  return { ...DEFAULT_APP_CONFIG.proxy, ...overrides };
}

describe('migrateLegacyModelAliases', () => {
  it('folds both legacy maps into alias routes and empties them', () => {
    const migrated = migrateLegacyModelAliases(
      proxyConfig({
        custom_mapping: { 'gpt-4o': 'gemini-3-pro' },
        anthropic_mapping: { 'claude-sonnet-4-5': 'gemini-3-flash' },
      }),
    );

    expect(migrated.model_aliases).toEqual([
      { alias: 'claude-sonnet-4-5', target: 'gemini-3-flash', enabled: true },
      { alias: 'gpt-4o', target: 'gemini-3-pro', enabled: true },
    ]);
    // The legacy maps stay as a projection of the enabled routes, so a rollback to a build that
    // predates model_aliases still finds the aliases where it looks for them.
    expect(migrated.custom_mapping).toEqual({
      'claude-sonnet-4-5': 'gemini-3-flash',
      'gpt-4o': 'gemini-3-pro',
    });
    expect(migrated.anthropic_mapping).toEqual({});
  });

  it('keeps the target the gateway routes to today when both maps claim one alias', () => {
    // Routing merges the two as {...custom, ...anthropic}, so the Anthropic entry is the one
    // that decides the request. The migration has to preserve that, not the declaration order.
    const migrated = migrateLegacyModelAliases(
      proxyConfig({
        custom_mapping: { 'my-model': 'from-custom' },
        anthropic_mapping: { 'my-model': 'from-anthropic' },
      }),
    );

    expect(migrated.model_aliases).toEqual([
      { alias: 'my-model', target: 'from-anthropic', enabled: true },
    ]);
  });

  it('lets an existing alias route win over a legacy entry for the same alias', () => {
    const migrated = migrateLegacyModelAliases(
      proxyConfig({
        model_aliases: [{ alias: 'my-model', target: 'already-declared', enabled: false }],
        anthropic_mapping: { 'my-model': 'from-anthropic' },
      }),
    );

    expect(migrated.model_aliases).toEqual([
      { alias: 'my-model', target: 'already-declared', enabled: false },
    ]);
  });

  it('keeps two aliases that differ only by case, because routing keeps them apart', () => {
    // Routing is an exact object lookup, so both of these resolve today and to different targets.
    // Case-insensitive dedupe would drop one and silently repoint the requests that used it.
    const migrated = migrateLegacyModelAliases(
      proxyConfig({
        custom_mapping: { 'GPT-4o': 'gemini-3-pro', 'gpt-4o': 'gemini-3-flash' },
      }),
    );

    expect(migrated.model_aliases).toEqual([
      { alias: 'GPT-4o', target: 'gemini-3-pro', enabled: true },
      { alias: 'gpt-4o', target: 'gemini-3-flash', enabled: true },
    ]);
    expect(getConfiguredModelMapping(migrated)).toEqual({
      'GPT-4o': 'gemini-3-pro',
      'gpt-4o': 'gemini-3-flash',
    });
  });

  it('drops half-declared routes and trims what it keeps', () => {
    const migrated = migrateLegacyModelAliases(
      proxyConfig({
        custom_mapping: { '  spaced  ': '  target  ', empty: '', '': 'no-alias' },
      }),
    );

    expect(migrated.model_aliases).toEqual([{ alias: 'spaced', target: 'target', enabled: true }]);
  });

  it('is idempotent, so running it on every load and save cannot accumulate routes', () => {
    const once = migrateLegacyModelAliases(
      proxyConfig({ custom_mapping: { 'gpt-4o': 'gemini-3-pro' } }),
    );

    expect(migrateLegacyModelAliases(once)).toEqual(once);
  });

  it('survives legacy fields that are not objects', () => {
    const migrated = migrateLegacyModelAliases(
      proxyConfig({
        custom_mapping: ['not', 'an', 'object'] as unknown as Record<string, string>,
        anthropic_mapping: null as unknown as Record<string, string>,
      }),
    );

    expect(migrated.model_aliases).toEqual([]);
  });
});

describe('getConfiguredModelMapping', () => {
  it('projects enabled routes into the exact-map shape routing and catalogs consume', () => {
    const mapping = getConfiguredModelMapping(
      proxyConfig({
        model_aliases: [
          { alias: 'gpt-4o', target: 'gemini-3-pro', enabled: true },
          { alias: 'retired', target: 'gemini-3-flash', enabled: false },
        ],
      }),
    );

    expect(mapping).toEqual({ 'gpt-4o': 'gemini-3-pro' });
  });

  it('still reads a config that never went through the migration', () => {
    const mapping = getConfiguredModelMapping(
      proxyConfig({
        custom_mapping: { 'gpt-4o': 'gemini-3-pro' },
        anthropic_mapping: { 'claude-sonnet-4-5': 'gemini-3-flash' },
      }),
    );

    expect(mapping).toEqual({
      'gpt-4o': 'gemini-3-pro',
      'claude-sonnet-4-5': 'gemini-3-flash',
    });
  });

  it('lets an alias route override a legacy entry for the same alias', () => {
    const mapping = getConfiguredModelMapping(
      proxyConfig({
        custom_mapping: { 'gpt-4o': 'stale' },
        model_aliases: [{ alias: 'gpt-4o', target: 'current', enabled: true }],
      }),
    );

    expect(mapping).toEqual({ 'gpt-4o': 'current' });
  });

  it('answers an absent config with no mapping rather than throwing', () => {
    expect(getConfiguredModelMapping(undefined)).toEqual({});
    expect(getConfiguredModelMapping(null)).toEqual({});
  });
});
