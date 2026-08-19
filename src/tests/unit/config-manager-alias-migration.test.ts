import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const agentDir = vi.hoisted(() => ({ value: '' }));

vi.mock('@/shared/platform/paths', () => ({
  getAgentDir: () => agentDir.value,
}));

// The real logger opens a rotating file transport in the directory under test and keeps it open
// past the teardown that removes it, which turns a passing run into a wall of ENOENT.
vi.mock('@/shared/logging/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * The migration only earns its keep where it touches the user's file. These cases drive
 * `ConfigManager` itself rather than the pure function: a config written by an older build has
 * to come back migrated, and the next save has to retire the legacy maps on disk instead of
 * writing them out again.
 */
describe('ConfigManager alias migration', () => {
  let configPath: string;

  beforeEach(() => {
    agentDir.value = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-config-'));
    configPath = path.join(agentDir.value, 'gui_config.json');
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(agentDir.value, { recursive: true, force: true });
  });

  function writeLegacyConfig(): void {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        proxy: {
          custom_mapping: { 'gpt-4o': 'gemini-3-pro' },
          anthropic_mapping: { 'my-claude': 'gemini-3-flash' },
        },
      }),
      'utf-8',
    );
  }

  it('returns a config written by an older build already migrated', async () => {
    writeLegacyConfig();
    const { ConfigManager } = await import('@/modules/config/ipc/manager');

    const loaded = ConfigManager.loadConfig();

    expect(loaded.proxy.model_aliases).toEqual([
      { alias: 'my-claude', target: 'gemini-3-flash', enabled: true },
      { alias: 'gpt-4o', target: 'gemini-3-pro', enabled: true },
    ]);
    expect(loaded.proxy.custom_mapping).toEqual({
      'my-claude': 'gemini-3-flash',
      'gpt-4o': 'gemini-3-pro',
    });
    expect(loaded.proxy.anthropic_mapping).toEqual({});
  });

  it('retires the legacy maps on disk at the next save', async () => {
    writeLegacyConfig();
    const { ConfigManager } = await import('@/modules/config/ipc/manager');

    const loaded = ConfigManager.loadConfig();
    await ConfigManager.saveConfig(loaded);

    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(written.proxy.model_aliases).toHaveLength(2);
    // Rollback safety: an older build reads custom_mapping and still finds both aliases.
    expect(written.proxy.custom_mapping).toEqual({
      'my-claude': 'gemini-3-flash',
      'gpt-4o': 'gemini-3-pro',
    });
    expect(written.proxy.anthropic_mapping).toEqual({});
  });

  it('keeps one pre-migration backup, and does not take a second on the next save', async () => {
    writeLegacyConfig();
    const backupPath = `${configPath}.pre-alias-migration.bak`;
    const { ConfigManager } = await import('@/modules/config/ipc/manager');

    await ConfigManager.saveConfig(ConfigManager.loadConfig());
    const firstBackup = fs.readFileSync(backupPath, 'utf-8');

    // The snapshot is of the pre-migration file, so it must not carry the new field...
    expect(firstBackup).not.toContain('model_aliases');
    expect(JSON.parse(firstBackup).proxy.custom_mapping).toEqual({ 'gpt-4o': 'gemini-3-pro' });

    // ...and a later save must not overwrite it with an already-migrated config.
    await ConfigManager.saveConfig(ConfigManager.loadConfig());
    expect(fs.readFileSync(backupPath, 'utf-8')).toBe(firstBackup);
  });

  it('leaves no temporary file behind, so a reader never sees a half-written config', async () => {
    writeLegacyConfig();
    const { ConfigManager } = await import('@/modules/config/ipc/manager');

    await ConfigManager.saveConfig(ConfigManager.loadConfig());

    expect(fs.readdirSync(agentDir.value).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    // The config still parses -- a rename either happened or did not, never halfway.
    expect(() => JSON.parse(fs.readFileSync(configPath, 'utf-8'))).not.toThrow();
  });

  it('migrates a config handed straight to save without a load', async () => {
    // The IPC path can save a config the renderer built, which never passed through loadConfig.
    const { ConfigManager } = await import('@/modules/config/ipc/manager');
    const { DEFAULT_APP_CONFIG } = await import('@/modules/config/types');

    await ConfigManager.saveConfig({
      ...DEFAULT_APP_CONFIG,
      proxy: { ...DEFAULT_APP_CONFIG.proxy, custom_mapping: { 'gpt-4o': 'gemini-3-pro' } },
    });

    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(written.proxy.model_aliases).toEqual([
      { alias: 'gpt-4o', target: 'gemini-3-pro', enabled: true },
    ]);
    expect(ConfigManager.getCachedConfig()?.proxy.custom_mapping).toEqual({
      'gpt-4o': 'gemini-3-pro',
    });
  });
});
