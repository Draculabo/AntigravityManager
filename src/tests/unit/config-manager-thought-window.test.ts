import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThoughtStoreConfigSchema } from '@/modules/config/types';

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
        throw new Error('synthetic save refusal');
      }
      return actual.writeFileAtomic(...args);
    },
  };
});

describe('independent thought retention settings', () => {
  beforeEach(() => {
    state.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-thought-window-'));
    state.failSave = false;
    vi.resetModules();
  });
  afterEach(() => {
    const resolved = path.resolve(state.directory);
    expect(path.dirname(resolved)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(resolved).startsWith('agm-thought-window-')).toBe(true);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  it('defaults L1 to 600, permits 10–10,000 and owns a separate 1 GiB durable budget', () => {
    expect(ThoughtStoreConfigSchema.parse({})).toEqual({
      enabled: true,
      retention_days: 15,
      max_sessions: 2000,
      max_turns_per_session: 600,
      max_session_mib: 64,
      max_disk_mib: 1024,
    });
    expect(ThoughtStoreConfigSchema.safeParse({ max_turns_per_session: 9 }).success).toBe(false);
    expect(
      ThoughtStoreConfigSchema.parse({ max_turns_per_session: 10_000 }).max_turns_per_session,
    ).toBe(10_000);
  });
  it.each([1, 9, 200])(
    'preserves explicit %i turns or migrates the old sub-ten range with exact backup and restoration',
    async (turns) => {
      const file = path.join(state.directory, 'gui_config.json');
      const original = JSON.stringify({
        proxy: {
          model_aliases: [],
          thought_store: {
            max_turns_per_session: turns,
            max_session_mib: 8,
            retention_days: 30,
            max_sessions: 100,
          },
        },
      });
      fs.writeFileSync(file, original);
      const { ConfigManager } = await import('@/modules/config/ipc/manager');
      const loaded = ConfigManager.loadConfig(true);
      expect(loaded.proxy.thought_store).toMatchObject({
        max_turns_per_session: Math.max(10, turns),
        max_disk_mib: 1024,
        max_session_mib: 8,
        retention_days: 30,
        max_sessions: 100,
      });
      expect(fs.readFileSync(file, 'utf8')).toBe(original);
      state.failSave = true;
      await expect(ConfigManager.saveConfig(loaded)).rejects.toThrow();
      const backup = `${file}.pre-thought-window-migration.bak`;
      expect(fs.readFileSync(backup, 'utf8')).toBe(original);
      expect(fs.readFileSync(file, 'utf8')).toBe(original);
      state.failSave = false;
      await ConfigManager.saveConfig(loaded);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).proxy.thought_store).toEqual(
        loaded.proxy.thought_store,
      );
      fs.copyFileSync(backup, file);
      vi.resetModules();
      const restored = (await import('@/modules/config/ipc/manager')).ConfigManager.loadConfig(
        true,
      );
      expect(restored.proxy.thought_store.max_turns_per_session).toBe(Math.max(10, turns));
      expect(fs.readFileSync(backup, 'utf8')).toBe(original);
    },
  );
  it('does not replace a damaged recovery copy or persist when it cannot be verified', async () => {
    const file = path.join(state.directory, 'gui_config.json');
    const original = '{"proxy":{"thought_store":{"max_turns_per_session":5}}}';
    fs.writeFileSync(file, original);
    fs.writeFileSync(`${file}.pre-thought-window-migration.bak`, '{}');
    const { ConfigManager } = await import('@/modules/config/ipc/manager');
    await expect(ConfigManager.saveConfig(ConfigManager.loadConfig(true))).rejects.toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.readFileSync(`${file}.pre-thought-window-migration.bak`, 'utf8')).toBe('{}');
  });
});
