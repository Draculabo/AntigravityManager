import { describe, expect, it } from 'vitest';
import {
  OPEN_CODE_API_KEY_PLACEHOLDER,
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
});
