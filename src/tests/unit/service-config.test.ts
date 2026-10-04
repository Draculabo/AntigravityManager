import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { call } from '@orpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { DEFAULT_CLOUD_ACCOUNT_ALERT_POLICY } from '@/modules/cloud-account/services/cloud-account-alert-policy.schema';
import {
  ServiceConfigUpdateSchema,
  ServiceConfigSnapshotSchema,
  DesktopPreferencesSchema,
} from '@/modules/config/service-config.schema';
import { splitSettingsChange } from '@/modules/config/settings-change';

const fixture = vi.hoisted(() => ({
  directory: '',
  apply: vi.fn(async () => {}),
  port: 0,
  policy: new Map<string, unknown>(),
}));
vi.mock('@/modules/cloud-account/persistence/cloud-account-settings-store', () => ({
  CloudAccountSettingsStore: {
    getSetting: (key: string, fallback: unknown) => fixture.policy.get(key) ?? fallback,
    setAlertPolicy: (input: object) => {
      for (const [key, value] of Object.entries(input)) {
        fixture.policy.set(key, value);
      }
    },
  },
}));
vi.mock('@/shared/platform/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/platform/paths')>()),
  getAgentDir: () => fixture.directory,
}));
vi.mock('electron', () => ({ app: { getPath: () => fixture.directory } }));
vi.mock('@/shared/logging/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    setErrorReportingEnabled: vi.fn(),
  },
}));
vi.mock('@/modules/antigravity-runtime/utils/autoStart', () => ({ syncAutoStart: vi.fn() }));
vi.mock('@/modules/proxy-gateway/audit/traffic-audit.service', () => ({
  trafficAuditService: {
    configure: fixture.apply,
    recordAdminOperation: vi.fn(),
    subscribe: () => () => {},
  },
}));
vi.mock('@/modules/proxy-gateway/thought-store/thought-store.service', () => ({
  thoughtStoreService: { configure: fixture.apply },
}));
vi.mock('@/server/main', () => ({
  getNestServerStatus: async () => ({
    running: fixture.port > 0,
    port: fixture.port,
    base_url: '',
    active_accounts: 0,
  }),
  bootstrapNestServer: vi.fn(),
  stopNestServer: vi.fn(),
}));

let endpoint = '';
let close: (() => Promise<void>) | undefined;
const legacy = () => path.join(fixture.directory, 'gui_config.json');
const preferences = () => path.join(fixture.directory, 'desktop-preferences.json');
const readDisk = async () => JSON.parse(await fs.readFile(legacy(), 'utf8'));

beforeEach(async () => {
  vi.resetModules();
  fixture.apply.mockReset().mockResolvedValue(undefined);
  fixture.port = 0;
  fixture.policy.clear();
  fixture.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-service-config-'));
  endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\${path.basename(fixture.directory)}`
      : path.join(fixture.directory, 'core.sock');
  await fs.writeFile(
    legacy(),
    JSON.stringify({
      ...DEFAULT_APP_CONFIG,
      theme: 'light',
      proxy: {
        ...DEFAULT_APP_CONFIG.proxy,
        api_key: 'fixture-key-private',
        upstream_proxy: { enabled: true, url: 'http://fixture-user:fixture-pass@localhost:8080' },
      },
    }),
  );
});
afterEach(async () => {
  await close?.();
  close = undefined;
  await fs.rm(fixture.directory, { recursive: true, force: true });
});

async function connected() {
  const { ManagementServer } = await import('@/core/management/server');
  const { CoreRpcClient } = await import('@/core/rpc/client');
  const { createCoreRpcOperations } = await import('@/core/rpc/router');
  const operations = createCoreRpcOperations({ startGateway: vi.fn(), stopGateway: vi.fn() });
  const server = new ManagementServer({
    endpoint,
    getStatus: () => ({
      state: 'running',
      pid: process.pid,
      gateway: { running: false, port: null },
    }),
    shutdown: async () => {},
    onShutdownError: vi.fn(),
    rpc: operations,
  });
  await server.start();
  close = () => server.close();
  return { operations, client: new CoreRpcClient(endpoint, 2000) };
}

describe('service configuration', () => {
  it('keeps configuration available to admitted tool work during shutdown', async () => {
    const { client, operations } = await connected();
    const { serviceConfigService } = await import('@/modules/config/service-config.service');
    const { agentToolsOwner } =
      await import('@/modules/proxy-gateway/agent-tools/agent-tools.owner');
    const drain = vi.spyOn(agentToolsOwner, 'drain').mockImplementation(async () => {
      expect(
        await serviceConfigService.ensureModelAlias('codex-auto-review', 'gemini-3.1-pro-high'),
      ).toBe('added');
    });
    try {
      operations.closeAccountMutationAdmission();
      await expect(
        client.updateServiceConfig({ proxy: { request_timeout: 900 } }),
      ).rejects.toThrow();
      await operations.drainAccountMutations();
      expect((await readDisk()).proxy.request_timeout).not.toBe(900);
      expect((await readDisk()).proxy.model_aliases).toEqual([
        { alias: 'codex-auto-review', target: 'gemini-3.1-pro-high', enabled: true },
      ]);
      await expect(serviceConfigService.ensureModelAlias('late', 'model')).rejects.toThrow();
    } finally {
      drain.mockRestore();
    }
  }, 15000);
  it('serializes additive review routes with settings edits and preserves explicit routes', async () => {
    const { serviceConfigService } = await import('@/modules/config/service-config.service');
    await Promise.all([
      serviceConfigService.ensureModelAlias('codex-auto-review', 'gemini-3.1-pro-high'),
      serviceConfigService.update({ proxy: { request_timeout: 241 } }),
    ]);
    expect((await readDisk()).proxy.request_timeout).toBe(241);
    expect((await readDisk()).proxy.model_aliases).toEqual([
      { alias: 'codex-auto-review', target: 'gemini-3.1-pro-high', enabled: true },
    ]);
    expect(
      await serviceConfigService.ensureModelAlias('codex-auto-review', 'different-model'),
    ).toBe('existing');
    await serviceConfigService.update({
      proxy: {
        model_aliases: [{ alias: 'codex-auto-review', target: 'custom-model', enabled: false }],
      },
    });
    expect(
      await serviceConfigService.ensureModelAlias('codex-auto-review', 'different-model'),
    ).toBe('disabled');
    expect((await readDisk()).proxy.model_aliases).toEqual([
      { alias: 'codex-auto-review', target: 'custom-model', enabled: false },
    ]);
  });
  it('reads legacy configuration through real RPC without secrets and applies patches only in the service', async () => {
    const { client } = await connected();
    const { serviceConfigService } = await import('@/modules/config/service-config.service');
    const before = await client.readServiceConfig();
    expect(before).toEqual(await serviceConfigService.read());
    expect(JSON.stringify(before)).not.toMatch(
      /fixture-key-private|fixture-user|fixture-pass|api_key"|url"/,
    );
    const result = await client.updateServiceConfig({
      antigravity_cli_executable: '/fixture/agy',
      proxy: {
        request_timeout: 222,
        global_system_prompt: { enabled: true, content: 'x'.repeat(6000) },
      },
    });
    expect(result.state).toBe('applied');
    expect(result.snapshot.antigravity_cli_executable).toBe('/fixture/agy');
    expect((await readDisk()).proxy).toMatchObject({
      api_key: 'fixture-key-private',
      request_timeout: 222,
      scheduling_mode: 'balance',
    });
    expect((await readDisk()).proxy.global_system_prompt.content).toHaveLength(6000);
    expect(await serviceConfigService.read()).toEqual(result.snapshot);
    const { selectConfigAdapter } = await import('@/modules/config/ipc/config-adapter');
    const { configRouter } = await import('@/modules/config/ipc/router');
    selectConfigAdapter({ mode: 'standalone-core', client });
    fixture.apply.mockClear();
    const saved = await call(configRouter.service.update, { proxy: { port: 8046 } });
    expect(saved.state).toBe('applied');
    expect(fixture.apply).toHaveBeenCalledTimes(2);
    expect(await call(configRouter.service.read, undefined)).toEqual(saved.snapshot);
  }, 15000);

  it('replaces/removes secrets without returning them in writes; reveal is explicit', async () => {
    const { client } = await connected();
    expect(await client.revealServiceSecret('api-key')).toEqual({ value: 'fixture-key-private' });
    const write = await client.writeServiceSecret({
      name: 'api-key',
      value: 'replacement-private',
    });
    expect(write.snapshot.proxy.api_key_configured).toBe(true);
    expect(JSON.stringify(write)).not.toContain('replacement-private');
    expect(await client.revealServiceSecret('api-key')).toEqual({ value: 'replacement-private' });
    await client.writeServiceSecret({ name: 'upstream-proxy', value: null });
    expect((await client.readServiceConfig()).proxy.upstream_proxy_configured).toBe(false);
    expect(await client.revealServiceSecret('upstream-proxy')).toEqual({ value: '' });
    await client.writeServiceSecret({ name: 'api-key', value: null });
    expect((await client.readServiceConfig()).proxy.api_key_configured).toBe(false);
    const generated = await client.generateServiceApiKey();
    expect(generated.snapshot.proxy.api_key_configured).toBe(true);
    expect(JSON.stringify(generated)).not.toMatch(/sk-[a-f0-9]{32}/);
    expect((await client.revealServiceSecret('api-key')).value).toMatch(/^sk-[a-f0-9]{32}$/);
  });

  it('preserves persisted changes when runtime application fails and marks port changes requiring restart', async () => {
    const { client } = await connected();
    fixture.apply.mockRejectedValue(new Error('fixture-key-private fixture-pass'));
    const result = await client.updateServiceConfig({ proxy: { request_timeout: 321 } });
    expect(result.state).toBe('restart-required');
    expect((await readDisk()).proxy.request_timeout).toBe(321);
    const { logger } = await import('@/shared/logging/logger');
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toMatch(
      /fixture-key-private|fixture-pass/,
    );
    fixture.apply.mockResolvedValue(undefined);
    fixture.port = 8045;
    expect((await client.updateServiceConfig({ proxy: { port: 8048 } })).state).toBe(
      'restart-required',
    );
  });

  it('rejects malformed and oversized inputs before persistence and keeps partial patches partial', async () => {
    const { client } = await connected();
    const previous = await fs.readFile(legacy(), 'utf8');
    expect(ServiceConfigUpdateSchema.parse({ proxy: { enabled: true } })).toEqual({
      proxy: { enabled: true },
    });
    expect(ServiceConfigUpdateSchema.safeParse({ theme: 'dark' }).success).toBe(false);
    expect(
      ServiceConfigUpdateSchema.safeParse({ proxy: { api_key: 'fixture-key-private' } }).success,
    ).toBe(false);
    await expect(client.updateServiceConfig({ proxy: { port: 100000 } })).rejects.toThrow();
    await expect(
      client.updateServiceConfig({
        proxy: { global_system_prompt: { enabled: true, content: 'x'.repeat(32769) } },
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(legacy(), 'utf8')).toBe(previous);
    expect(fixture.apply).not.toHaveBeenCalled();
    expect(
      ServiceConfigSnapshotSchema.safeParse({
        ...(await client.readServiceConfig()),
        injected: 'secret',
      }).success,
    ).toBe(false);
  });

  it('drains admitted persistence/application and closes new mutation admission', async () => {
    const { operations, client } = await connected();
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.apply.mockImplementation(async () => {
      started();
      await blocked;
    });
    const write = client.updateServiceConfig({ proxy: { request_timeout: 444 } });
    await ready;
    operations.closeAccountMutationAdmission();
    let drained = false;
    const drain = operations.drainAccountMutations().then(() => {
      drained = true;
    });
    await expect(client.updateServiceConfig({ proxy: { request_timeout: 555 } })).rejects.toThrow(
      'Settings are unavailable right now',
    );
    expect(drained).toBe(false);
    expect((await client.readServiceConfig()).proxy.request_timeout).toBe(444);
    release();
    await write;
    await drain;
    expect(drained).toBe(true);
  });

  it('serializes simultaneous field patches without reverting other settings', async () => {
    const { client } = await connected();
    await Promise.all([
      client.updateServiceConfig({ proxy: { request_timeout: 111 } }),
      client.updateServiceConfig({ proxy: { max_wait_seconds: 77 } }),
    ]);
    expect((await readDisk()).proxy).toMatchObject({ request_timeout: 111, max_wait_seconds: 77 });
  });

  it('keeps desktop preferences writable offline without owner fallback or legacy rewrites', async () => {
    await fs.writeFile(
      legacy(),
      JSON.stringify({ ...(await readDisk()), owner_mode: 'standalone-core' }),
    );
    const { client } = await connected();
    const { selectConfigAdapter } = await import('@/modules/config/ipc/config-adapter');
    const { configRouter } = await import('@/modules/config/ipc/router');
    selectConfigAdapter({ mode: 'standalone-core', client });
    const initial = await call(configRouter.desktop.load, undefined);
    expect(initial.theme).toBe('light');
    expect(initial.owner_mode).toBeUndefined();
    const legacyBefore = await fs.readFile(legacy(), 'utf8');
    await close?.();
    close = undefined;
    await expect(call(configRouter.service.update, { proxy: { port: 8050 } })).rejects.toThrow(
      'Settings are unavailable right now',
    );
    await expect(call(configRouter.service.read, undefined)).rejects.toThrow(
      'Settings are unavailable right now',
    );
    const saved = await call(configRouter.desktop.save, {
      ...initial,
      theme: 'dark',
      auto_startup: true,
      owner_mode: 'standalone-core',
    });
    expect(await call(configRouter.desktop.load, undefined)).toEqual(saved);
    expect(saved.owner_mode).toBe('standalone-core');
    expect(await fs.readFile(legacy(), 'utf8')).toBe(legacyBefore);
    expect(fixture.apply).not.toHaveBeenCalled();
    expect(await fs.readFile(preferences(), 'utf8')).not.toMatch(
      /fixture-key-private|fixture-pass|proxy"/,
    );
    await fs.writeFile(legacy(), JSON.stringify({ ...DEFAULT_APP_CONFIG, theme: 'another-theme' }));
    expect((await call(configRouter.desktop.load, undefined)).theme).toBe('dark');
  });

  it('does not reseed or overwrite a corrupt desktop file', async () => {
    const { desktopPreferencesStore } = await import('@/modules/config/ipc/desktop-preferences');
    await fs.writeFile(preferences(), '{invalid');
    await expect(desktopPreferencesStore.load()).rejects.toThrow('Desktop preferences are invalid');
    expect(await fs.readFile(preferences(), 'utf8')).toBe('{invalid');
  });

  it('keeps effective SQLite alert policy independent of stale GUI copies', async () => {
    const { client, operations } = await connected();
    fixture.policy.set('quota_alert_enabled', true);
    fixture.policy.set('quota_alert_threshold', 42);
    const before = await fs.readFile(legacy(), 'utf8');
    expect(await client.readAccountAlertPolicy()).toEqual({
      ...DEFAULT_CLOUD_ACCOUNT_ALERT_POLICY,
      quota_alert_enabled: true,
      quota_alert_threshold: 42,
    });
    expect(await client.updateAccountAlertPolicy({ quota_alert_threshold: 10 })).toEqual({
      ...DEFAULT_CLOUD_ACCOUNT_ALERT_POLICY,
      quota_alert_enabled: true,
      quota_alert_threshold: 10,
    });
    expect(fixture.policy.get('quota_alert_threshold')).toBe(10);
    expect(await fs.readFile(legacy(), 'utf8')).toBe(before);
    await expect(client.updateAccountAlertPolicy({ quota_alert_threshold: 101 })).rejects.toThrow();
    expect(fixture.policy.get('quota_alert_threshold')).toBe(10);
    operations.closeAccountMutationAdmission();
    await expect(client.updateAccountAlertPolicy({ quota_alert_enabled: false })).rejects.toThrow(
      'Settings are unavailable right now',
    );
  });

  it('loads desktop observability consent after restart without promoting stale GUI values', async () => {
    const { desktopPreferencesStore } = await import('@/modules/config/ipc/desktop-preferences');
    await desktopPreferencesStore.load();
    await desktopPreferencesStore.save({
      error_reporting_enabled: false,
      telemetry_enabled: false,
    });
    const { getQuickObservabilityConfig } =
      await import('@/shared/observability/observabilityConfig');
    expect(getQuickObservabilityConfig(undefined, preferences())).toEqual({
      errorReportingEnabled: false,
      telemetryEnabled: false,
    });
    await fs.writeFile(preferences(), '{fixture-key-private');
    const report = vi.fn();
    expect(getQuickObservabilityConfig(report, preferences())).toEqual({
      errorReportingEnabled: false,
      telemetryEnabled: false,
    });
    expect(JSON.stringify(report.mock.calls)).not.toContain('fixture-key-private');
  });

  it('merges concurrent desktop field patches without resetting existing preferences', async () => {
    const { desktopPreferencesStore } = await import('@/modules/config/ipc/desktop-preferences');
    await desktopPreferencesStore.load();
    await Promise.all([
      desktopPreferencesStore.save({ theme: 'dark' }),
      desktopPreferencesStore.save({ auto_startup: true }),
    ]);
    expect(await desktopPreferencesStore.load()).toMatchObject({
      theme: 'dark',
      auto_startup: true,
    });
  });

  it('splits UI-only edits from owner patches and rejects secret snapshot fields', async () => {
    const { serviceConfigService } = await import('@/modules/config/service-config.service');
    const previous = {
      ...DesktopPreferencesSchema.strip().parse(DEFAULT_APP_CONFIG),
      ...DEFAULT_CLOUD_ACCOUNT_ALERT_POLICY,
      ...(await serviceConfigService.read()),
    };
    expect(splitSettingsChange(previous, { ...previous, theme: 'light' })).toEqual({
      desktop: { theme: 'light' },
      accountAlertPolicy: null,
      service: null,
    });
    expect(
      splitSettingsChange(previous, {
        ...previous,
        proxy: { ...previous.proxy, request_timeout: 200 },
      }),
    ).toEqual({
      desktop: null,
      accountAlertPolicy: null,
      service: { proxy: { request_timeout: 200 } },
    });
    expect(splitSettingsChange(previous, { ...previous, quota_alert_threshold: 25 })).toEqual({
      desktop: null,
      service: null,
      accountAlertPolicy: { quota_alert_threshold: 25 },
    });
  });
});
