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
  DesktopPreferencesUpdateSchema,
} from '@/modules/config/service-config.schema';
import { splitSettingsChange } from '@/modules/config/settings-change';
import { mockCoreGatewayLifecycle } from '../support/core-gateway-lifecycle';

const fixture = vi.hoisted(() => ({
  directory: '',
  apply: vi.fn(async () => {}),
  port: 0,
  listenAddress: '',
  restartFields: vi.fn<(config: import('@/modules/config/types').ProxyConfig) => string[]>(
    () => [],
  ),
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
  getNestServerRestartFields: fixture.restartFields,
  getNestServerStatus: async () => ({
    running: fixture.port > 0,
    port: fixture.port,
    base_url: '',
    active_accounts: 0,
    listen_address: fixture.listenAddress,
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
  fixture.listenAddress = '';
  fixture.restartFields.mockReset();
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
  const operations = createCoreRpcOperations(mockCoreGatewayLifecycle());
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
  it('round trips alias publication through Core and persists route removal without resurrecting legacy projections', async () => {
    const { client } = await connected();
    const aliases = [
      { alias: 'private-fast', target: 'gemini-3-flash', enabled: true, published: false },
      { alias: 'auto-opus', target: 'auto:claude-opus', enabled: true, published: true },
      { alias: 'legacy-public', target: 'gemini-3-flash', enabled: true },
    ];
    const saved = await client.updateServiceConfig({ proxy: { model_aliases: aliases } });
    expect(saved.state).toBe('applied');
    expect(saved.snapshot.proxy.model_aliases).toEqual(aliases);
    expect((await client.readServiceConfig()).proxy.model_aliases).toEqual(aliases);
    expect((await readDisk()).proxy.model_aliases).toEqual(aliases);
    expect((await readDisk()).proxy.custom_mapping).toEqual({
      'private-fast': 'gemini-3-flash',
      'auto-opus': 'auto:claude-opus',
      'legacy-public': 'gemini-3-flash',
    });
    const removed = await client.updateServiceConfig({
      proxy: { model_aliases: [], custom_mapping: {}, anthropic_mapping: {} },
    });
    expect(removed.state).toBe('applied');
    expect(removed.snapshot.proxy.model_aliases).toEqual([]);
    expect((await readDisk()).proxy.custom_mapping).toEqual({});
    expect((await client.readServiceConfig()).proxy.model_aliases).toEqual([]);
  }, 15000);

  it('keeps omitted Cowork fields out of partial configuration writes', () => {
    const patch = { proxy: { cowork_compaction: { manual_enabled: true } } };
    expect(ServiceConfigUpdateSchema.parse(patch)).toEqual(patch);
  });

  it('rejects new zero Gateway budgets over RPC while preserving readable legacy values', async () => {
    const stored = await readDisk();
    stored.proxy.thinking_budget.claude_budget = 0;
    await fs.writeFile(legacy(), JSON.stringify(stored));
    const { client } = await connected();
    expect((await client.readServiceConfig()).proxy.thinking_budget.claude_budget).toBe(0);
    const before = await readDisk();
    await expect(
      client.updateServiceConfig({ proxy: { thinking_budget: { claude_high: 0 } } }),
    ).rejects.toThrow('positive whole number');
    expect(await readDisk()).toEqual(before);
    await client.updateServiceConfig({ proxy: { thinking_budget: { control_source: 'client' } } });
    const clientMode = await readDisk();
    expect(clientMode.proxy.thinking_budget.claude_budget).toBe(0);
    await expect(
      client.updateServiceConfig({ proxy: { thinking_budget: { control_source: 'gateway' } } }),
    ).rejects.toThrow('positive whole number');
    expect(await readDisk()).toEqual(clientMode);
    const saved = await client.updateServiceConfig({
      proxy: {
        thinking_budget: { control_source: 'gateway', claude_budget: -1, claude_high: 8192 },
      },
    });
    expect(saved.snapshot.proxy.thinking_budget).toEqual({
      ...before.proxy.thinking_budget,
      claude_budget: -1,
      claude_high: 8192,
    });
  }, 15000);

  it('maps a Gateway budget write failure to a fixed invalid-input response through ORPC', async () => {
    const { serviceConfigService } = await import('@/modules/config/service-config.service');
    const { createServiceConfigRouter } = await import('@/modules/config/service-config.router');
    const router = createServiceConfigRouter(serviceConfigService);
    const before = await readDisk();
    await expect(
      call(router.update, { proxy: { thinking_budget: { flash_low: 0 } } }),
    ).rejects.toMatchObject({ data: { configCode: 'invalid-input' } });
    expect(await readDisk()).toEqual(before);
  });

  it('persists the API account strategy through real RPC and applies it without changing client auto-switch', async () => {
    const { client } = await connected();
    const { getServerConfig } = await import('@/server/server-config');
    const before = await readDisk();
    const result = await client.updateServiceConfig({
      proxy: { account_selection_strategy: 'account-first' },
    });
    expect(result.state).toBe('applied');
    expect(result.snapshot.proxy.account_selection_strategy).toBe('account-first');
    expect((await client.readServiceConfig()).proxy.account_selection_strategy).toBe(
      'account-first',
    );
    expect(getServerConfig()?.account_selection_strategy).toBe('account-first');
    expect(await readDisk()).toEqual({
      ...before,
      proxy: { ...before.proxy, account_selection_strategy: 'account-first' },
    });
    expect(
      ServiceConfigUpdateSchema.safeParse({ proxy: { account_selection_strategy: 'invalid' } })
        .success,
    ).toBe(false);
  }, 15000);

  it('keeps Cowork trust and switches independent across partial RPC updates', async () => {
    const { client } = await connected();
    const { getServerConfig } = await import('@/server/server-config');
    const trustedFingerprints = ['a'.repeat(64)];
    const expected = {
      manual_enabled: true,
      auto_enabled: false,
      auto_threshold: 85_000,
      trusted_client_key_hashes: trustedFingerprints,
    };

    await client.updateServiceConfig({
      proxy: { cowork_compaction: { manual_enabled: true, auto_threshold: 85_000 } },
    });
    const trusted = await client.updateServiceConfig({
      proxy: { cowork_compaction: { trusted_client_key_hashes: trustedFingerprints } },
    });
    expect(trusted.snapshot.proxy.cowork_compaction).toEqual(expected);

    const automatic = await client.updateServiceConfig({
      proxy: { cowork_compaction: { auto_enabled: true } },
    });
    const expectedAutomatic = { ...expected, auto_enabled: true };
    expect(automatic.state).toBe('applied');
    expect(automatic.snapshot.proxy.cowork_compaction).toEqual(expectedAutomatic);
    expect((await readDisk()).proxy.cowork_compaction).toEqual(expectedAutomatic);
    expect(getServerConfig()?.cowork_compaction).toEqual(expectedAutomatic);

    const revoked = await client.updateServiceConfig({
      proxy: { cowork_compaction: { trusted_client_key_hashes: [] } },
    });
    expect(revoked.snapshot.proxy.cowork_compaction).toEqual({
      ...expectedAutomatic,
      trusted_client_key_hashes: [],
    });
  }, 15000);

  it('persists a partial image-window strategy through RPC without changing scheduler concurrency', async () => {
    const { client } = await connected();
    const before = await readDisk();
    const image_scheduler = {
      ...before.proxy.image_scheduler,
      send_window_enabled: true,
      send_window_strategy: 'memory',
      send_window_memory_mib: 16,
    };
    const result = await client.updateServiceConfig({
      proxy: {
        image_scheduler: {
          send_window_enabled: true,
          send_window_strategy: 'memory',
          send_window_memory_mib: 16,
        },
      },
    });
    expect(result.snapshot.proxy.image_scheduler).toEqual(image_scheduler);
    expect((await client.readServiceConfig()).proxy.image_scheduler).toEqual(image_scheduler);
    expect(await readDisk()).toEqual({ ...before, proxy: { ...before.proxy, image_scheduler } });
    expect(
      ServiceConfigUpdateSchema.safeParse({
        proxy: { image_scheduler: { send_window_strategy: 'combined' } },
      }).success,
    ).toBe(false);
  }, 15000);

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
  it('allows an unrelated save over historical ambiguous Claude aliases', async () => {
    const config = await readDisk();
    await fs.writeFile(
      legacy(),
      JSON.stringify({
        ...config,
        proxy: {
          ...config.proxy,
          anthropic_mapping: {},
          custom_mapping: {},
          model_aliases: [
            { alias: 'claude-sonnet-4.5', target: 'gemini-3.7-flash', enabled: true },
            { alias: 'anthropic/claude-sonnet-4-5', target: 'gemini-3.5-flash', enabled: true },
          ],
        },
      }),
    );
    const { serviceConfigService } = await import('@/modules/config/service-config.service');

    await expect(serviceConfigService.update({ proxy: { port: 8051 } })).resolves.toMatchObject({
      snapshot: { proxy: { port: 8051 } },
    });
    expect((await readDisk()).proxy.model_aliases).toHaveLength(2);
  });

  it('rejects a model alias edit that introduces a Claude equivalence conflict', async () => {
    const config = await readDisk();
    await fs.writeFile(
      legacy(),
      JSON.stringify({
        ...config,
        proxy: {
          ...config.proxy,
          anthropic_mapping: {},
          custom_mapping: {},
          model_aliases: [
            { alias: 'claude-sonnet-4.5', target: 'gemini-3.7-flash', enabled: true },
            { alias: 'anthropic/claude-sonnet-4-5', target: 'gemini-3.5-flash', enabled: true },
          ],
        },
      }),
    );
    const before = await fs.readFile(legacy(), 'utf8');
    const { serviceConfigService } = await import('@/modules/config/service-config.service');

    await expect(
      serviceConfigService.update({
        proxy: {
          model_aliases: [
            { alias: 'claude-sonnet-4.5', target: 'gemini-3.7-flash', enabled: true },
            { alias: 'claude.sonnet.4-5', target: 'gemini-3.5-flash', enabled: true },
          ],
        },
      }),
    ).rejects.toThrow('Ambiguous Claude-normalized model aliases');
    expect(await fs.readFile(legacy(), 'utf8')).toBe(before);
    expect(fixture.apply).not.toHaveBeenCalled();
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

  it('rejects enabling an upstream proxy without a saved address', async () => {
    const { client } = await connected();
    await client.writeServiceSecret({ name: 'upstream-proxy', value: null });
    await client.updateServiceConfig({ proxy: { upstream_proxy: { enabled: false } } });
    const before = await readDisk();
    await expect(
      client.updateServiceConfig({ proxy: { upstream_proxy: { enabled: true } } }),
    ).rejects.toMatchObject({ data: { configCode: 'invalid-input' } });
    expect(await readDisk()).toEqual(before);
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
    const cleared = await client.writeServiceSecret({ name: 'upstream-proxy', value: null });
    expect(cleared.snapshot.proxy.upstream_proxy).toEqual({ enabled: false });
    expect((await client.readServiceConfig()).proxy.upstream_proxy_configured).toBe(false);
    expect((await readDisk()).proxy.upstream_proxy).toEqual({ enabled: false, url: '' });
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
    expect(result.state).toBe('partial-failure');
    expect((await readDisk()).proxy.request_timeout).toBe(321);
    const { logger } = await import('@/shared/logging/logger');
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toMatch(
      /fixture-key-private|fixture-pass/,
    );
    fixture.apply.mockResolvedValue(undefined);
    fixture.port = 8045;
    fixture.restartFields.mockImplementation((proxy) =>
      proxy.port !== fixture.port ? ['proxy.port'] : [],
    );
    expect((await client.updateServiceConfig({ proxy: { port: 8048 } })).state).toBe(
      'restart-required',
    );
  });

  it('marks a LAN toggle as restart-required while the gateway is running', async () => {
    const { client } = await connected();
    fixture.port = 8045;
    fixture.listenAddress = '::';
    fixture.restartFields.mockImplementation((proxy) =>
      proxy.network.lan_access ? [] : ['proxy.network.lan_access'],
    );
    await client.writeServiceSecret({ name: 'api-key', value: 'fixture-key-private' });
    await client.updateServiceConfig({ proxy: { network: { lan_access: true } } });
    const result = await client.updateServiceConfig({
      proxy: { network: { lan_access: false } },
    });
    expect(result.state).toBe('restart-required');
    expect((await readDisk()).proxy.network.lan_access).toBe(false);
  });

  it('does not clear the key while the running listener is still external', async () => {
    const { client } = await connected();
    fixture.port = 8045;
    fixture.listenAddress = '0.0.0.0';
    await client.writeServiceSecret({ name: 'api-key', value: 'fixture-key-private' });
    await expect(client.writeServiceSecret({ name: 'api-key', value: null })).rejects.toThrow(
      'Settings are unavailable right now',
    );
    expect((await readDisk()).proxy.api_key).toBe('fixture-key-private');
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
  it('rejects a stale audit revision inside the serialized owner without overwriting the winner', async () => {
    const { client } = await connected();
    const snapshot = await client.readServiceConfig();
    expect(snapshot.auditRevision).toMatch(/^[a-f0-9]{64}$/u);
    const outcomes = await Promise.allSettled([
      client.updateServiceConfig({
        expectedAuditRevision: snapshot.auditRevision,
        proxy: { traffic_audit: { max_disk_mib: 2048 } },
      }),
      client.updateServiceConfig({
        expectedAuditRevision: snapshot.auditRevision,
        proxy: { traffic_audit: { max_rows: 120000 } },
      }),
    ]);
    expect(outcomes.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = outcomes.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' ? rejected.reason : null).toMatchObject({
      data: { configCode: 'conflict' },
    });
    const after = await client.readServiceConfig();
    expect(after.auditRevision).not.toBe(snapshot.auditRevision);
    await expect(
      client.updateServiceConfig({ proxy: { traffic_audit: { enabled: false } } }),
    ).rejects.toMatchObject({ data: { configCode: 'conflict' } });
    expect(JSON.stringify(await readDisk())).not.toContain('expectedAuditRevision');
    // An unrelated update does not invalidate the audit editor's revision.
    await client.updateServiceConfig({ proxy: { request_timeout: 222 } });
    expect((await client.readServiceConfig()).auditRevision).toBe(after.auditRevision);
    expect(
      (
        await client.updateServiceConfig({
          expectedAuditRevision: after.auditRevision,
          proxy: { traffic_audit: { max_rows: 140000 } },
        })
      ).state,
    ).toBe('applied');
  });

  it('does not apply or advance the audit revision after persistence fails, and permits a deliberate retry', async () => {
    const { client } = await connected();
    const { ConfigManager } = await import('@/modules/config/ipc/manager');
    const before = await client.readServiceConfig();
    const disk = await readDisk();
    const save = vi
      .spyOn(ConfigManager, 'saveConfig')
      .mockRejectedValueOnce(new Error('synthetic disk refusal'));
    fixture.apply.mockClear();
    const patch = {
      expectedAuditRevision: before.auditRevision,
      proxy: { traffic_audit: { max_rows: 2000 } },
    };
    try {
      await expect(client.updateServiceConfig(patch)).rejects.toThrow();
      expect(fixture.apply).not.toHaveBeenCalled();
      expect(await readDisk()).toEqual(disk);
      expect((await client.readServiceConfig()).auditRevision).toBe(before.auditRevision);
      expect((await client.updateServiceConfig(patch)).state).toBe('applied');
      expect((await readDisk()).proxy.traffic_audit.max_rows).toBe(2000);
    } finally {
      save.mockRestore();
    }
  });

  it('merges nested settings patches without dropping sibling fields', async () => {
    const { client } = await connected();
    await client.updateServiceConfig({
      proxy: {
        global_system_prompt: { enabled: true, content: 'keep this content' },
        experimental: { allow_local_video_paths: true },
      },
    });

    await client.updateServiceConfig({
      proxy: { global_system_prompt: { enabled: false } },
    });

    expect((await readDisk()).proxy.global_system_prompt).toEqual({
      enabled: false,
      content: 'keep this content',
    });
    expect((await readDisk()).proxy.experimental.allow_local_video_paths).toBe(true);
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

  it('keeps the legacy desktop language when seeding preferences', async () => {
    await fs.writeFile(legacy(), JSON.stringify({ language: 'zh-CN' }));
    const { desktopPreferencesStore } = await import('@/modules/config/ipc/desktop-preferences');
    expect(await desktopPreferencesStore.load()).toMatchObject({
      language: 'zh-CN',
      zoom_percent: 100,
    });
  });

  it('defaults a fresh desktop profile to English at 100% zoom and restores saved appearance', async () => {
    await fs.unlink(legacy());
    const { configRouter } = await import('@/modules/config/ipc/router');
    const initial = await call(configRouter.desktop.load, undefined);
    expect(initial).toMatchObject({ language: 'en', zoom_percent: 100 });
    expect(await fs.readFile(preferences(), 'utf8')).not.toContain('zoom_percent');

    const saved = await call(configRouter.desktop.save, { language: 'pt_BR', zoom_percent: 125 });
    expect(saved).toEqual({ ...initial, language: 'pt-BR', zoom_percent: 125 });
    const { createDesktopPreferencesStore } = await import('@/modules/config/ipc/desktop-preferences');
    const reopened = createDesktopPreferencesStore(preferences, legacy);
    expect(await reopened.load()).toEqual(saved);
    await call(configRouter.desktop.save, { theme: 'dark' });
    expect((await reopened.load()).zoom_percent).toBe(125);

    expect(DesktopPreferencesUpdateSchema.safeParse({ zoom_percent: 175 }).success).toBe(false);
    expect((await reopened.load()).zoom_percent).toBe(125);
    await call(configRouter.desktop.save, { zoom_percent: 100 });
    expect((await reopened.load()).zoom_percent).toBe(100);
    const raw = JSON.parse(await fs.readFile(preferences(), 'utf8'));
    expect(DesktopPreferencesSchema.omit({ zoom_percent: true }).parse(raw.preferences).language).toBe('pt-BR');
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
