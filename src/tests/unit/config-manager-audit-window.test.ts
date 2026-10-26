import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ directory: '', failSave: false }));
vi.mock('@/shared/platform/paths', () => ({ getAgentDir: () => state.directory }));
vi.mock('@/shared/logging/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/shared/persistence/atomic-json-file', async (original) => {
  const actual = await original<typeof import('@/shared/persistence/atomic-json-file')>();
  return {
    ...actual,
    writeFileAtomic: async (...args: Parameters<typeof actual.writeFileAtomic>) => {
      if (state.failSave && args[0].endsWith('gui_config.json')) {
        throw new Error('Synthetic replacement failure');
      }
      return actual.writeFileAtomic(...args);
    },
  };
});

describe('audit capacity window configuration migration', () => {
  let configPath: string;
  let backupPath: string;
  beforeEach(() => {
    state.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-audit-window-'));
    state.failSave = false;
    configPath = path.join(state.directory, 'gui_config.json');
    backupPath = `${configPath}.pre-audit-window-migration.bak`;
    vi.resetModules();
  });
  afterEach(() => {
    fs.rmSync(state.directory, { recursive: true, force: true });
  });

  function writeLegacy() {
    const original =
      '{\n  "proxy": {"model_aliases": [], "traffic_audit": {' +
      '"enabled":false,"max_disk_mib":256,"max_rows":2500,' +
      '"body_retention_hours":48,"summary_retention_days":90}},"language":"en"\n}\n';
    fs.writeFileSync(configPath, original);
    return original;
  }

  it('loads new defaults without creating a file and preserves explicit older capacities', async () => {
    const { ConfigManager } = await import('@/modules/config/ipc/manager');
    expect(ConfigManager.loadConfig().proxy.traffic_audit).toEqual({
      enabled: true,
      capture_successful_probes: false,
      max_disk_mib: 1024,
      max_rows: 100_000,
      max_queue_records: 512,
      max_queue_mib: 16,
    });
    expect(fs.existsSync(configPath)).toBe(false);
    const original = writeLegacy();
    expect(ConfigManager.loadConfig().proxy.traffic_audit).toEqual({
      enabled: false,
      capture_successful_probes: false,
      max_disk_mib: 256,
      max_rows: 2500,
      max_queue_records: 512,
      max_queue_mib: 16,
    });
    expect(fs.readFileSync(configPath, 'utf8')).toBe(original);
    expect(fs.existsSync(backupPath)).toBe(false);
  });

  it('backs up exact original bytes before retiring age settings and supports restoration', async () => {
    const original = writeLegacy();
    const { ConfigManager } = await import('@/modules/config/ipc/manager');
    const loaded = ConfigManager.loadConfig();
    loaded.proxy.traffic_audit.max_disk_mib = 512;
    await ConfigManager.saveConfig(loaded);
    expect(fs.readFileSync(backupPath, 'utf8')).toBe(original);
    const saved: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(saved).toMatchObject({ proxy: { traffic_audit: loaded.proxy.traffic_audit } });
    expect(fs.readFileSync(configPath, 'utf8')).not.toMatch(
      /body_retention_hours|summary_retention_days/u,
    );
    await ConfigManager.saveConfig(loaded);
    expect(fs.readFileSync(backupPath, 'utf8')).toBe(original);

    // Restore with the owner stopped; a fresh owner sees the original user choices.
    fs.copyFileSync(backupPath, configPath);
    vi.resetModules();
    const { ConfigManager: Restored } = await import('@/modules/config/ipc/manager');
    expect(Restored.loadConfig().proxy.traffic_audit.max_disk_mib).toBe(256);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(original);
  });

  for (const obstruction of ['directory', 'invalid-json', 'unrelated-json']) {
    it(`preserves configuration and cache when the backup is ${obstruction}`, async () => {
      const original = writeLegacy();
      if (obstruction === 'directory') {
        fs.mkdirSync(backupPath);
      } else {
        fs.writeFileSync(backupPath, obstruction === 'invalid-json' ? '{broken' : '{}');
      }
      const { ConfigManager } = await import('@/modules/config/ipc/manager');
      const before = ConfigManager.loadConfig();
      const next = {
        ...before,
        proxy: {
          ...before.proxy,
          traffic_audit: {
            ...before.proxy.traffic_audit,
            max_disk_mib: 512,
          },
        },
      };
      await expect(ConfigManager.saveConfig(next)).rejects.toThrow(
        'Configuration could not be saved.',
      );
      expect(ConfigManager.getCachedConfig()).toBe(before);
      expect(fs.readFileSync(configPath, 'utf8')).toBe(original);
    });
  }

  it('retains the recovery copy after save failure and lets the next queued save succeed', async () => {
    const original = writeLegacy();
    const { ConfigManager } = await import('@/modules/config/ipc/manager');
    const before = ConfigManager.loadConfig();
    const next = {
      ...before,
      proxy: {
        ...before.proxy,
        traffic_audit: {
          ...before.proxy.traffic_audit,
          max_rows: 5000,
        },
      },
    };
    state.failSave = true;
    await expect(ConfigManager.saveConfig(next)).rejects.toThrow(
      'Configuration could not be saved.',
    );
    expect(fs.readFileSync(backupPath, 'utf8')).toBe(original);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(original);
    expect(ConfigManager.getCachedConfig()).toBe(before);
    state.failSave = false;
    await ConfigManager.saveConfig(next);
    expect(ConfigManager.getCachedConfig()?.proxy.traffic_audit.max_rows).toBe(5000);
    expect(fs.readFileSync(backupPath, 'utf8')).toBe(original);
  });

  it('fills missing capacity and leaves a current configuration without an audit backup', async () => {
    fs.writeFileSync(configPath, '{"proxy":{"traffic_audit":{"enabled":false}}}');
    const { ConfigManager } = await import('@/modules/config/ipc/manager');
    const config = ConfigManager.loadConfig();
    expect(config.proxy.traffic_audit.max_disk_mib).toBe(1024);
    await ConfigManager.saveConfig(config);
    expect(fs.existsSync(backupPath)).toBe(false);
  });
});
