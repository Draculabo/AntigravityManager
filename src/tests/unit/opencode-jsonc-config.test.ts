import { describe, expect, it } from 'vitest';
import { parse } from 'jsonc-parser';
import {
  OPEN_CODE_API_KEY_PLACEHOLDER,
  clearOpenCodeConfigJsonc,
  injectOpenCodeApiKeyAfterRestore,
  redactOpenCodeApiKeyForBackup,
  updateOpenCodeConfigJsonc,
} from '@/modules/proxy-gateway/opencode-sync/opencode-jsonc-config';

describe('OpenCode JSONC config editing', () => {
  const source = [
    '{',
    '  // Keep this root comment.',
    '  "$schema": "https://opencode.ai/config.json",',
    '  "theme":    "custom",',
    '  "provider": {',
    '    "antigravity-manager": {',
    '      // Keep the provider comment.',
    '      "npm": "@ai-sdk/anthropic",',
    '      "name": "My custom provider name",',
    '      "options": {',
    '        "baseURL": "http://127.0.0.1:8045/v1",',
    '        "apiKey": "old-dedicated-key",',
    '      },',
    '      "models": {',
    '        "claude-sonnet-4-6": {',
    '          // Keep the hand-maintained model comment.',
    '          "name": "Custom Sonnet",',
    '          "custom": true,',
    '          "modalities": {',
    '            "input": [',
    '              // Keep the array comment.',
    '              "text", "image", "pdf",',
    '            ],',
    '            "output": ["text"],',
    '          },',
    '        },',
    '      },',
    '    },',
    '  },',
    '}',
    '',
  ].join('\r\n');

  it('updates only targeted JSONC fields while preserving comments and formatting', () => {
    const updated = updateOpenCodeConfigJsonc(source, {
      apiKey: 'new-dedicated-key',
      baseUrl: 'http://127.0.0.1:9123',
      models: [{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }],
    });

    expect(updated).toContain('// Keep this root comment.');
    expect(updated).toContain('// Keep the provider comment.');
    expect(updated).toContain('// Keep the hand-maintained model comment.');
    expect(updated).toContain('// Keep the array comment.');
    expect(updated).toContain('"theme":    "custom"');
    expect(updated).toContain('"name": "My custom provider name"');
    expect(updated).toContain('"custom": true');
    expect(updated).toContain('"baseURL": "http://127.0.0.1:9123/v1"');
    expect(updated).toContain('"apiKey": "new-dedicated-key"');
    expect(updated).toContain('\r\n');
    expect(updated.endsWith('\r\n')).toBe(true);
  });

  it('redacts the dedicated key in backups and injects the current key on restore', () => {
    const backup = redactOpenCodeApiKeyForBackup(source);

    expect(backup).not.toContain('old-dedicated-key');
    expect(backup).toContain(OPEN_CODE_API_KEY_PLACEHOLDER);
    expect(backup).toContain('// Keep the provider comment.');

    const restored = injectOpenCodeApiKeyAfterRestore(backup, 'current-dedicated-key');

    expect(restored).not.toContain(OPEN_CODE_API_KEY_PLACEHOLDER);
    expect(restored).toContain('"apiKey": "current-dedicated-key"');
    expect(restored).toContain('// Keep the provider comment.');
    expect(restored).toContain('"theme":    "custom"');
  });

  it('adds a provider without rewriting existing root content', () => {
    const minimal = '{\n\t// user setting\n\t"theme": "dark",\n}\n';

    const updated = updateOpenCodeConfigJsonc(minimal, {
      apiKey: 'dedicated-key',
      baseUrl: 'http://localhost:8045/',
      models: [{ id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' }],
    });

    expect(updated).toContain('\t// user setting');
    expect(updated).toContain('\t"theme": "dark"');
    expect(updated).toContain('"antigravity-manager"');
    expect(updated).toContain('"baseURL": "http://localhost:8045/v1"');
    expect(updated).toContain('"gemini-3.1-pro"');
    expect(updated).not.toContain('\r\n');
  });

  it('writes Gemini 3 effort variants and disables unsupported OpenCode slots', () => {
    const updated = updateOpenCodeConfigJsonc('{}\n', {
      apiKey: 'dedicated-key',
      baseUrl: 'http://127.0.0.1:8045',
      models: [
        { id: 'gemini-3.1-pro' },
        { id: 'gemini-3.5-flash' },
        { id: 'gemini-3.6-flash-high' },
      ],
    });
    const models = (
      parse(updated) as {
        provider: { 'antigravity-manager': { models: Record<string, { variants: unknown }> } };
      }
    ).provider['antigravity-manager'].models;

    expect(models['gemini-3.1-pro'].variants).toEqual({
      low: { effort: 'low' },
      medium: { disabled: true },
      high: { effort: 'high' },
      max: { disabled: true },
    });
    expect(Object.keys(models['gemini-3.1-pro'].variants as object)).toEqual([
      'low',
      'medium',
      'high',
      'max',
    ]);
    expect(models['gemini-3.5-flash'].variants).toEqual({
      low: { effort: 'low' },
      medium: { effort: 'medium' },
      high: { effort: 'high' },
      max: { disabled: true },
    });
    expect(models['gemini-3.7-flash']).toMatchObject({
      name: 'Gemini 3.7 Flash',
      limit: { context: 1000000, output: 65536 },
      modalities: {
        input: ['text', 'image', 'audio', 'video', 'pdf'],
        output: ['text'],
      },
      variants: {
        low: { effort: 'low' },
        medium: { effort: 'medium' },
        high: { effort: 'high' },
        max: { disabled: true },
      },
    });
    expect(models).not.toHaveProperty('gemini-3.6-flash-high');
  });

  it('renames a lone Gemini alias to its canonical key without losing comments', () => {
    const aliasSource = [
      '{',
      '  "provider": {',
      '    "antigravity-manager": {',
      '      "models": {',
      '        "gemini-3.1-pro-high": {',
      '          // alias-owned comment',
      '          "custom": true,',
      '        },',
      '      },',
      '    },',
      '  },',
      '}',
      '',
    ].join('\n');

    const updated = updateOpenCodeConfigJsonc(aliasSource, {
      apiKey: 'dedicated-key',
      baseUrl: 'http://127.0.0.1:8045',
      models: [{ id: 'gemini-3.1-pro-high' }],
    });

    expect(updated).toContain('"gemini-3.1-pro"');
    expect(updated).not.toContain('"gemini-3.1-pro-high"');
    expect(updated).toContain('// alias-owned comment');
    expect(updated).toContain('"custom": true');
  });

  it('merges an alias into an existing canonical model while retaining its comments', () => {
    const mergedSource = [
      '{',
      '  "provider": {',
      '    "antigravity-manager": {',
      '      "models": {',
      '        "gemini-3.1-pro": { "custom": "canonical" },',
      '        "gemini-3.1-pro-low": {',
      '          // retain this alias comment',
      '          "custom": "alias",',
      '          "aliasOnly": true,',
      '        },',
      '      },',
      '    },',
      '  },',
      '}',
      '',
    ].join('\n');

    const updated = updateOpenCodeConfigJsonc(mergedSource, {
      apiKey: 'dedicated-key',
      baseUrl: 'http://127.0.0.1:8045',
      models: [{ id: 'gemini-3.1-pro' }],
    });

    expect(updated).not.toContain('"gemini-3.1-pro-low"');
    expect(updated).toContain('// retain this alias comment');
    expect(updated).toContain('"custom": "canonical"');
    expect(updated).toContain('"aliasOnly": true');
  });

  it('clears the managed provider and legacy entries without deleting unrelated settings', () => {
    const clearSource = [
      '{',
      '  // root comment remains',
      '  "theme": "dark",',
      '  "provider": {',
      '    "antigravity-manager": { "options": { "apiKey": "managed-key" } },',
      '    "google": {',
      '      "options": { "baseURL": "http://127.0.0.1:8045", "apiKey": "legacy-key" },',
      '      "models": {',
      '        "gemini-3-flash": { "name": "Managed" },',
      '        "gemini-3.5-flash": { "name": "Canonical user entry" },',
      '        "user-model": { "name": "Keep" }',
      '      }',
      '    },',
      '    "anthropic": {',
      '      "options": { "baseURL": "https://unrelated.example/v1", "apiKey": "keep-key" },',
      '      "models": { "claude-sonnet-4-6": {}, "user-claude": {} }',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');

    const cleared = clearOpenCodeConfigJsonc(clearSource, {
      baseUrl: 'http://127.0.0.1:8045/v1',
      clearLegacy: true,
    });

    expect(cleared).toContain('// root comment remains');
    expect(cleared).toContain('"theme": "dark"');
    expect(cleared).not.toContain('"antigravity-manager"');
    expect(cleared).not.toContain('"gemini-3-flash"');
    expect(cleared).toContain('"gemini-3.5-flash"');
    expect(cleared).not.toContain('"claude-sonnet-4-6"');
    expect(cleared).not.toContain('"legacy-key"');
    expect(cleared).toContain('"user-model"');
    expect(cleared).toContain('"user-claude"');
    expect(cleared).toContain('"keep-key"');
  });

  it('keeps an emptied legacy provider object after clearing managed models', () => {
    const cleared = clearOpenCodeConfigJsonc(
      '{ "provider": { "google": { "models": { "gemini-3-flash": {} } } } }\n',
      {
        baseUrl: 'http://127.0.0.1:8045',
        clearLegacy: true,
      },
    );

    expect(cleared).toMatch(/"google"\s*:\s*\{\s*\}/);
  });

  it('writes Claude thinking variants for base Opus 4.5 and 4.6 ids', () => {
    const updated = updateOpenCodeConfigJsonc('{}\n', {
      apiKey: 'dedicated-key',
      baseUrl: 'http://127.0.0.1:8045',
      models: [{ id: 'claude-opus-4-5' }, { id: 'claude-opus-4-6' }],
    });
    const models = (
      parse(updated) as {
        provider: { 'antigravity-manager': { models: Record<string, unknown> } };
      }
    ).provider['antigravity-manager'].models;
    const variants = {
      low: {
        thinkingConfig: { thinkingBudget: 8192 },
        thinking: { type: 'enabled', budget_tokens: 8192, budgetTokens: 8192 },
      },
      medium: {
        thinkingConfig: { thinkingBudget: 16384 },
        thinking: { type: 'enabled', budget_tokens: 16384, budgetTokens: 16384 },
      },
      high: {
        thinkingConfig: { thinkingBudget: 24576 },
        thinking: { type: 'enabled', budget_tokens: 24576, budgetTokens: 24576 },
      },
      max: {
        thinkingConfig: { thinkingBudget: 32768 },
        thinking: { type: 'enabled', budget_tokens: 32768, budgetTokens: 32768 },
      },
    };

    expect(models['claude-opus-4-5']).toEqual({
      name: 'Claude Opus 4.5',
      limit: { context: 200000, output: 64000 },
      modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
      reasoning: true,
      variants,
    });
    expect(models['claude-opus-4-6']).toEqual({
      name: 'Claude Opus 4.6',
      limit: { context: 200000, output: 64000 },
      modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
      reasoning: true,
      variants,
    });
  });
});
