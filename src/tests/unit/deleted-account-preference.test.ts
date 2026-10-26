import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigManager } from '@/modules/config/ipc/manager';
import { createServiceConfigService } from '@/modules/config/service-config.service';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';

const state = vi.hoisted(() => ({ directory: '' }));
vi.mock('@/shared/platform/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/platform/paths')>()),
  getAgentDir: () => state.directory,
}));
vi.mock('@/server/main', () => ({ getNestServerStatus: vi.fn() }));
vi.mock('@/modules/proxy-gateway/audit/traffic-audit.service', () => ({
  trafficAuditService: { configure: vi.fn(), recordAdminOperation: vi.fn() },
}));
vi.mock('@/modules/proxy-gateway/thought-store/thought-store.service', () => ({
  thoughtStoreService: { configure: vi.fn() },
}));

const configPath = () => path.join(state.directory, 'gui_config.json');
beforeEach(async () => {
  state.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-deleted-pref-'));
  const config = structuredClone(DEFAULT_APP_CONFIG);
  config.proxy.preferred_account_id = 'deleted';
  config.proxy.api_key = 'synthetic-private-key';
  await fs.writeFile(configPath(), JSON.stringify(config));
});
afterEach(async () => {
  await fs.rm(state.directory, { recursive: true, force: true });
});

function service() {
  const apply = vi.fn(async () => true);
  const save = vi.fn((config: typeof DEFAULT_APP_CONFIG) => ConfigManager.saveConfig(config));
  const owner = createServiceConfigService({
    load: () => ConfigManager.loadConfig(),
    loadForCleanup: () => ConfigManager.loadConfig(true),
    save,
    apply,
    runningPort: async () => null,
  });
  return { owner, apply, save };
}

describe('deleted account preference ownership', () => {
  it('clears only the deleted preference on disk and after a fresh config read', async () => {
    const { owner } = service();
    const cached = ConfigManager.loadConfig();
    const before = structuredClone(cached);
    // Runtime cleanup may already have changed a shared cached object; disk is authoritative here.
    cached.proxy.preferred_account_id = '';
    await owner.clearDeletedAccountPreference('deleted');
    expect(ConfigManager.loadConfig()).toEqual({
      ...before,
      proxy: { ...before.proxy, preferred_account_id: '' },
    });
  });

  it('leaves a newer preferred account and a recreated account untouched', async () => {
    const { owner, save } = service();
    await owner.clearDeletedAccountPreference('other');
    await owner.clearDeletedAccountPreference('deleted', () => false);
    expect(save).not.toHaveBeenCalled();
    expect(ConfigManager.loadConfig().proxy.preferred_account_id).toBe('deleted');
  });

  it('serializes deletion cleanup with settings updates without losing fields or the later selection', async () => {
    const { owner, save } = service();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    save.mockImplementationOnce(async (config) => {
      entered.resolve();
      await resume.promise;
      await ConfigManager.saveConfig(config);
    });
    const first = owner.update({ proxy: { port: 12345 } });
    await entered.promise;
    const cleanup = owner.clearDeletedAccountPreference('deleted');
    const next = owner.update({ proxy: { preferred_account_id: 'replacement' } });
    resume.resolve();
    await Promise.all([first, cleanup, next]);
    expect(ConfigManager.loadConfig().proxy).toMatchObject({
      port: 12345,
      preferred_account_id: 'replacement',
      api_key: 'synthetic-private-key',
    });
  });

  it('does not replace an unreadable configuration with defaults', async () => {
    const { owner, save } = service();
    ConfigManager.loadConfig();
    await fs.writeFile(configPath(), '{synthetic-broken-json');
    await expect(owner.clearDeletedAccountPreference('deleted')).rejects.toThrow(
      'Configuration could not be loaded',
    );
    expect(save).not.toHaveBeenCalled();
    expect(await fs.readFile(configPath(), 'utf8')).toBe('{synthetic-broken-json');
  });

  it('retains save and runtime-application failures without automatic retry', async () => {
    const { owner, save, apply } = service();
    const failure = new Error('synthetic save failure');
    save.mockRejectedValueOnce(failure);
    await expect(owner.clearDeletedAccountPreference('deleted')).rejects.toBe(failure);
    expect(ConfigManager.loadConfig().proxy.preferred_account_id).toBe('deleted');
    expect(apply).not.toHaveBeenCalled();
    apply.mockRejectedValueOnce(new Error('synthetic apply failure'));
    await expect(owner.clearDeletedAccountPreference('deleted')).rejects.toThrow(
      'synthetic apply failure',
    );
    expect(ConfigManager.loadConfig().proxy.preferred_account_id).toBe('');
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('drains admitted cleanup and rejects cleanup after shutdown admission closes', async () => {
    const { owner } = service();
    const pending = owner.clearDeletedAccountPreference('deleted');
    owner.closeAdmission();
    await expect(owner.clearDeletedAccountPreference('other')).rejects.toThrow('shutting down');
    await owner.drain();
    await pending;
    expect(ConfigManager.loadConfig().proxy.preferred_account_id).toBe('');
  });
});
