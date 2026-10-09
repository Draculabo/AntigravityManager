import { agentToolsOwner } from '@/modules/proxy-gateway/agent-tools/agent-tools.owner';
import { auditFileOwner } from '@/modules/proxy-gateway/audit/audit-file-owner.service';
import { ipcCaptureOwner } from '@/modules/proxy-gateway/audit/ipc-capture-owner';
import { createIpcCaptureOwner } from '@/modules/proxy-gateway/audit/ipc-capture-owner';
import { createRemoteIpcAuditRecorder } from '@/modules/proxy-gateway/audit/remote-ipc-audit-recorder';
import { getTrafficAuditRequestContext } from '@/modules/proxy-gateway/audit/traffic-audit-context';
import { serializeAuditError } from '@/modules/proxy-gateway/audit/audit-parent-metadata';
import { createThoughtSessionKey } from '@/modules/proxy-gateway/audit/traffic-audit-http-metadata';
import type { TrafficAuditService } from '@/modules/proxy-gateway/audit/traffic-audit.service';
import { auditOwner } from '@/modules/proxy-gateway/audit/audit-owner.service';
import { auditCurlOwner } from '@/modules/proxy-gateway/traffic-monitor/audit-curl-owner.service';
import { thoughtOwner } from '@/modules/proxy-gateway/thought-store/thought-owner.service';
import { openCodeOwner } from '@/modules/proxy-gateway/opencode-sync/opencode-owner.service';
import { localAccountOwner } from '@/modules/account/services/local-account-owner.service';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagementServer } from '@/core/management/server';
import { ManagementClient, ServiceNotRunningError } from '@/core/management/client';
import { CoreRpcClient } from '@/core/rpc/client';
import { CoreRpcTransportError, createLocalRpcFetch } from '@/core/rpc/local-fetch';
import { createCoreRpcOperations, type CoreRpcOperations } from '@/core/rpc/router';
import { CoreService, type CoreStatus, type CoreDependencies } from '@/core/core-service';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { AgentToolsService } from '@/modules/proxy-gateway/agent-tools/agent-tools.service';
import { selectAgentToolsAdapter } from '@/modules/proxy-gateway/ipc/agent-tools-adapter';
import { gatewayRouter } from '@/modules/proxy-gateway/ipc/router';
import { createRouterClient } from '@orpc/server';
import { runCli } from '@/cli/app';

const closeables: Array<{ close(): Promise<void> }> = [];
const directories: string[] = [];

async function endpoint(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-rpc-'));
  directories.push(directory);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\agm-rpc-${path.basename(directory)}`
    : path.join(directory, 'core.sock');
}

afterEach(async () => {
  selectAgentToolsAdapter({ mode: 'desktop-embedded' });
  await Promise.all(closeables.splice(0).map((server) => server.close()));
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

const account = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'google' as const,
  email: 'example@example.com',
  name: 'Example',
  avatarUrl: null,
  status: 'active' as const,
  lastUsed: 42,
  quota: { subscriptionTier: 'pro', modelCount: 2 },
};

const accountView = {
  id: account.id,
  provider: account.provider,
  email: account.email,
  name: account.name,
  quota: { models: { gemini: { percentage: 50, resetTime: 'later' } } },
  created_at: 1,
  last_used: 42,
  is_active: true,
  is_active_classic: true,
  proxy_configured: false,
};

const deviceProfile = {
  machineId: 'machine',
  macMachineId: 'mac',
  devDeviceId: 'device',
  sqmId: '{SQM}',
};

function operations(): CoreRpcOperations {
  return {
    errorReporting: { setEnabled: vi.fn() },
    ipcCapture: ipcCaptureOwner,
    auditFile: auditFileOwner,
    audit: auditOwner,
    thought: thoughtOwner,
    auditCurl: auditCurlOwner,
    openCode: openCodeOwner,
    agentTools: agentToolsOwner,
    localAccount: localAccountOwner,
    accountAlertPolicy: { read: vi.fn(), update: vi.fn() },
    serviceConfig: {
      read: vi.fn(),
      update: vi.fn(),
      writeSecret: vi.fn(),
      revealSecret: vi.fn(),
      generateKey: vi.fn(),
    },
    localImport: {
      preview: vi.fn(),
      confirm: vi.fn(),
      discard: vi.fn(),
      getPostImportStatus: vi.fn(),
    },
    accountSwitchStatus: vi.fn(),
    accountEvents: () => ({ epoch: '11111111-1111-4111-8111-111111111111', latest: 0, events: [] }),
    monitor: {
      getAutoSwitchEnabled: () => false,
      setAutoSwitchEnabled: async () => {},
      getAutoSwitchModelsConfig: () => ({}),
      setAutoSwitchModelsConfig: async () => {},
      forcePoll: async () => {},
      getWeeklyWarmupConfig: () => ({ enabled: false, groups: ['claude', 'gemini'] }),
      setWeeklyWarmupConfig: async () => {},
    },
    accountFileImport: vi.fn(async () => ({
      imported: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      errors: [],
    })),
    accountFileExport: vi.fn(async () => ({ status: 'saved' as const })),
    accountSwitch: vi.fn(async () => ({ success: true as const })),
    accountProfileGet: vi.fn(async () => ({ history: [], boundProfile: deviceProfile })),
    accountProfilePreview: vi.fn(async () => deviceProfile),
    accountProfileBind: vi.fn(async () => deviceProfile),
    accountProfileBindPayload: vi.fn(async () => deviceProfile),
    accountProfileRestoreRevision: vi.fn(async () => deviceProfile),
    accountProfileRestoreBaseline: vi.fn(async () => deviceProfile),
    accountProfileDeleteRevision: vi.fn(async () => ({ success: true as const })),
    gatewayStatus: vi.fn(async () => ({
      running: true,
      port: 8045,
      base_url: 'http://localhost:8045',
      active_accounts: 1,
    })),
    contextCacheStatus: vi.fn(() => ({
      enabled: true,
      stats: {
        activeEntries: 1,
        creationFailures: 0,
        creations: 2,
        hits: 3,
        invalidations: 0,
        lookups: 4,
      },
    })),
    accountSummaries: vi.fn(async () => [account]),
    accountViews: vi.fn(async () => [accountView]),
    accountSecurityStatus: vi.fn(() => ({
      state: 'secure' as const,
      masterKeySource: 'keytar' as const,
    })),
    accountValidationUrl: vi.fn(async () => ({ url: 'https://accounts.google.com/verify?id=1' })),
    accountRefreshQuota: vi.fn(async () => accountView),
    accountSyncFromIde: vi.fn(async () => accountView),
    accountSetProxy: vi.fn(async () => ({ success: true as const })),
    accountDelete: vi.fn(async () => ({ success: true as const })),
    oauthClientList: vi.fn(() => [
      {
        key: 'test-client',
        label: 'Test Client',
        client_id: 'test-client-id',
        is_active: true,
        is_builtin: false,
      },
    ]),
    oauthClientActive: vi.fn(() => ({ client_key: 'test-client' })),
    oauthClientSet: vi.fn(() => ({ success: true as const })),
    gatewayStart: vi.fn(async (port) => ({
      success: true as const,
      port,
      base_url: `http://localhost:${port}`,
    })),
    gatewayStop: vi.fn(async () => ({ success: true as const })),
  };
}

describe('core application RPC', () => {
  it('configures and restores tools from CLI and the desktop adapter over real private RPC', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-tool-rpc-'));
    directories.push(home);
    const service = new AgentToolsService({
      home,
      env: { CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined },
      key: async () => 'fixture-private-key',
      ensureReviewRoute: async () => {},
      detect: async () => ({ installed: true, version: '1.2.3' }),
    });
    const rpc = operations();
    rpc.agentTools = service;
    const socketPath = await endpoint();
    const server = new ManagementServer({
      endpoint: socketPath,
      getStatus: () => ({
        state: 'running',
        pid: process.pid,
        gateway: { running: false, port: null },
      }),
      shutdown: async () => {},
      onShutdownError: vi.fn(),
      rpc,
    });
    closeables.push(server);
    await server.start();
    const client = new CoreRpcClient(socketPath);
    const output = { stdout: vi.fn(), stderr: vi.fn() };
    const launcher = { start: vi.fn(), stop: vi.fn(), status: vi.fn() };
    const baseUrl = 'http://127.0.0.1:8045/v1';
    expect(
      await runCli(
        ['tools', 'configure', 'codex', '--base-url', baseUrl, '--model', 'gemini-3.1-pro-high'],
        launcher,
        output,
        undefined,
        undefined,
        client,
      ),
    ).toBe(0);
    expect((await client.agentTools.status('codex', baseUrl)).isSynced).toBe(true);
    expect(await fs.readFile(path.join(home, '.codex/config.toml'), 'utf8')).toContain(
      'antigravity_manager',
    );
    selectAgentToolsAdapter({ mode: 'standalone-core', client });
    const renderer = createRouterClient(gatewayRouter);
    expect(
      await renderer.agentTools.configure({
        tool: 'claude',
        baseUrl,
        model: 'claude-sonnet-4-6-thinking',
      }),
    ).toEqual({ configPath: path.join(home, '.claude/settings.json'), restartRequired: true });
    const preview = await renderer.agentTools.preview({ tool: 'claude' });
    expect(preview.content).not.toContain('fixture-private-key');
    expect((await renderer.agentTools.status({ tool: 'claude', baseUrl })).isSynced).toBe(true);
    await renderer.agentTools.restore({ tool: 'claude' });
    await client.agentTools.restore('codex');
    await expect(fs.access(path.join(home, '.claude/settings.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.access(path.join(home, '.codex/config.toml'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await server.close();
    await expect(
      renderer.agentTools.configure({ tool: 'claude', baseUrl, model: 'model' }),
    ).rejects.toThrow('Could not update the tool settings');
    await expect(fs.access(path.join(home, '.claude/settings.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }, 15000);
  it('streams large IPC capture and carries owner context over the real private endpoint', async () => {
    const captured: string[] = [];
    const sessionId = 'pipe-session' + '你好'.repeat(3000);
    const model = 'nested-model' + '\\"'.repeat(2000);
    const start = vi.fn<TrafficAuditService['startParent']>(() => ({
      id: 'private-parent',
      startedAt: 1,
      trafficClass: 'ipc',
    }));
    const finish = vi.fn();
    const owner = createIpcCaptureOwner({
      startParent: start,
      completeParent: finish,
      beginPreparedParentPayload: () => ({
        append: async (data) => {
          captured.push(data);
          return true;
        },
        finish: async () => {},
      }),
    });
    const rpc = operations();
    rpc.ipcCapture = owner;
    rpc.contextCacheStatus = () => {
      expect(getTrafficAuditRequestContext()?.parent?.id).toBe('private-parent');
      expect(getTrafficAuditRequestContext()?.thoughtSessionKey).toBe(
        createThoughtSessionKey({}, sessionId),
      );
      return {
        enabled: false,
        stats: {
          activeEntries: 0,
          creationFailures: 0,
          creations: 0,
          hits: 0,
          invalidations: 0,
          lookups: 0,
        },
      };
    };
    const socketPath = await endpoint();
    const server = new ManagementServer({
      endpoint: socketPath,
      getStatus: () => ({ state: 'running', pid: 123, gateway: { running: false, port: null } }),
      shutdown: async () => {},
      onShutdownError: vi.fn(),
      rpc,
    });
    closeables.push(server);
    await server.start();
    const client = new CoreRpcClient(socketPath);
    const text = '\\"你好'.repeat(30_000);
    const recorder = createRemoteIpcAuditRecorder(client);
    await expect(
      recorder.run(
        ['cloud', 'refresh'],
        { sessionId, request: { model }, text, access_token: 'secret' },
        async () => {
          await client.contextCacheStatus();
          return { output: text };
        },
      ),
    ).resolves.toEqual({ output: text });
    expect(captured.join('')).not.toContain('secret');
    expect(captured.join('')).toContain('[REDACTED]');
    expect(finish).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[0]).toMatchObject({ sessionId, model });
    const failure = new Error('long failure ' + 'trace'.repeat(2000));
    failure.stack = 'complete stack ' + 'stack'.repeat(4000);
    await expect(
      recorder.run(['cloud', 'failure'], null, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(finish.mock.calls[1]?.[1]).toMatchObject({
      errorSummary: serializeAuditError(failure),
      outcome: 'internal_error',
      status: 500,
    });
    owner.closeAdmission();
    await owner.drain();
  });
  it('round trips typed operations over the private management endpoint', async () => {
    const socketPath = await endpoint();
    const rpc = operations();
    const server = new ManagementServer({
      endpoint: socketPath,
      getStatus: () => ({ state: 'running', pid: 123, gateway: { running: true, port: 8045 } }),
      shutdown: async () => {},
      onShutdownError: vi.fn(),
      rpc,
    });
    closeables.push(server);
    await server.start();

    const client = new CoreRpcClient(socketPath);
    expect(await client.ping()).toBe('pong');
    expect(await client.gatewayStatus()).toEqual(await rpc.gatewayStatus());
    expect(await client.contextCacheStatus()).toEqual(rpc.contextCacheStatus());
    expect(await client.accountSummaries()).toEqual([account]);
    expect(await client.accountViews()).toEqual([accountView]);
    expect(await client.accountSecurityStatus()).toEqual({
      state: 'secure',
      masterKeySource: 'keytar',
    });
    expect(await client.resolveAccountValidationUrl(account.id)).toBe(
      'https://accounts.google.com/verify?id=1',
    );
    expect(await client.refreshAccountQuota(account.id)).toEqual(accountView);
    expect(await client.syncFromIde('ide')).toEqual(accountView);
    expect(await client.switchCloudAccount(account.id, 'ide')).toBeUndefined();
    expect(rpc.accountSwitch).toHaveBeenCalledWith(account.id, 'ide');
    expect(await client.getIdentityProfiles(account.id)).toEqual({
      history: [],
      boundProfile: deviceProfile,
    });
    expect(await client.previewIdentityProfile()).toEqual(deviceProfile);
    expect(await client.bindIdentityProfile(account.id, 'capture')).toEqual(deviceProfile);
    expect(await client.bindIdentityProfileWithPayload(account.id, deviceProfile)).toEqual(
      deviceProfile,
    );
    expect(await client.restoreIdentityProfileRevision(account.id, 'current')).toEqual(
      deviceProfile,
    );
    expect(await client.restoreBaselineProfile(account.id)).toEqual(deviceProfile);
    expect(await client.deleteIdentityProfileRevision(account.id, 'revision-1')).toBeUndefined();
    expect(rpc.accountProfileBind).toHaveBeenCalledWith(account.id, 'capture');
    expect(rpc.accountProfileBindPayload).toHaveBeenCalledWith(account.id, deviceProfile);
    expect(rpc.accountProfileRestoreRevision).toHaveBeenCalledWith(account.id, 'current');
    expect(rpc.accountProfileDeleteRevision).toHaveBeenCalledWith(account.id, 'revision-1');
    const proxyUrl = 'http://proxy-user:proxy-password@127.0.0.1:7890';
    expect(await client.setAccountProxy(account.id, proxyUrl)).toBeUndefined();
    expect(await client.setAccountProxy(account.id, null)).toBeUndefined();
    expect(await client.deleteCloudAccount(account.id)).toBeUndefined();
    expect(rpc.accountSetProxy).toHaveBeenCalledWith(account.id, proxyUrl);
    expect(rpc.accountSetProxy).toHaveBeenCalledWith(account.id, null);
    expect(rpc.accountDelete).toHaveBeenCalledWith(account.id);
    expect(await client.listOAuthClients()).toEqual(rpc.oauthClientList());
    expect(await client.getActiveOAuthClient()).toBe('test-client');
    expect(await client.setActiveOAuthClient('test-client')).toBeUndefined();
    expect(rpc.oauthClientSet).toHaveBeenCalledWith('test-client');
    expect(JSON.stringify(await client.accountSummaries())).not.toMatch(
      /access_token|refresh_token|client_secret|tokenJson/,
    );
    expect(rpc.accountSummaries).toHaveBeenCalledTimes(2);
    expect(rpc.accountViews).toHaveBeenCalledTimes(1);
    expect(rpc.accountRefreshQuota).toHaveBeenCalledWith(account.id);
    expect(rpc.accountSyncFromIde).toHaveBeenCalledWith('ide');
  }, 15_000);

  it('rejects calls during startup, shutdown, and after admission closes', async () => {
    const socketPath = await endpoint();
    let state: CoreStatus['state'] = 'starting';
    const rpc = operations();
    const server = new ManagementServer({
      endpoint: socketPath,
      getStatus: () => ({ state, pid: 123, gateway: { running: false, port: null } }),
      shutdown: async () => {},
      onShutdownError: vi.fn(),
      rpc,
    });
    closeables.push(server);
    await server.start();
    const client = new CoreRpcClient(socketPath);

    await expect(client.ping()).rejects.toThrow();
    state = 'running';
    expect(await client.ping()).toBe('pong');
    server.beginShutdown();
    await expect(client.ping()).rejects.toThrow();
    state = 'stopping';
    await expect(client.ping()).rejects.toThrow();
    expect(rpc.accountSummaries).not.toHaveBeenCalled();
  });

  it('does not return internal account errors to RPC clients', async () => {
    const socketPath = await endpoint();
    const rpc = operations();
    rpc.accountSummaries = vi.fn(async () => {
      throw new Error('secret-token-from-storage');
    });
    const server = new ManagementServer({
      endpoint: socketPath,
      getStatus: () => ({ state: 'running', pid: 123, gateway: { running: false, port: null } }),
      shutdown: async () => {},
      onShutdownError: vi.fn(),
      rpc,
    });
    closeables.push(server);
    await server.start();

    try {
      await new CoreRpcClient(socketPath).accountSummaries();
      expect.fail('Account RPC should reject failed storage reads');
    } catch (error) {
      expect(String(error)).not.toContain('secret-token-from-storage');
    }
  });

  it('does not expose provider details from a failed quota refresh', async () => {
    const socketPath = await endpoint();
    const rpc = operations();
    rpc.accountRefreshQuota = vi.fn(async () => {
      throw new Error('provider failed with private-access-token and proxy-user:proxy-password');
    });
    const server = new ManagementServer({
      endpoint: socketPath,
      getStatus: () => ({ state: 'running', pid: 123, gateway: { running: false, port: null } }),
      shutdown: async () => {},
      onShutdownError: vi.fn(),
      rpc,
    });
    closeables.push(server);
    await server.start();

    try {
      await new CoreRpcClient(socketPath).refreshAccountQuota(account.id);
      expect.fail('Quota RPC should reject provider failures');
    } catch (error) {
      expect(String(error)).not.toMatch(/private-access-token|proxy-user:proxy-password/);
    }
  });

  it('returns a stable switch error over the private endpoint without owner diagnostics', async () => {
    const socketPath = await endpoint();
    const rpc = operations();
    rpc.accountSwitch = vi.fn(async () => {
      throw new Error('private-access-token proxy-user:proxy-password');
    });
    const server = new ManagementServer({
      endpoint: socketPath,
      getStatus: () => ({ state: 'running', pid: 123, gateway: { running: false, port: null } }),
      shutdown: async () => {},
      onShutdownError: vi.fn(),
      rpc,
    });
    closeables.push(server);
    await server.start();

    try {
      await new CoreRpcClient(socketPath).switchCloudAccount(account.id, 'agy');
      expect.fail('Switch should reject');
    } catch (error) {
      expect(error).toMatchObject({ data: { switchCode: 'switch-failed' } });
      expect(JSON.stringify(error)).not.toMatch(/private-access-token|proxy-user:proxy-password/);
    }
    expect(rpc.accountSwitch).toHaveBeenCalledWith(account.id, 'agy');
  });

  it('allows quota refresh to finish beyond the five-second management timeout', async () => {
    const socketPath = await endpoint();
    const rpc = operations();
    rpc.accountRefreshQuota = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5100));
      return accountView;
    });
    const server = new ManagementServer({
      endpoint: socketPath,
      getStatus: () => ({ state: 'running', pid: 123, gateway: { running: false, port: null } }),
      shutdown: async () => {},
      onShutdownError: vi.fn(),
      rpc,
    });
    closeables.push(server);
    await server.start();

    expect(await new CoreRpcClient(socketPath).refreshAccountQuota(account.id)).toEqual(
      accountView,
    );
  }, 10_000);

  it('classifies a missing service and rejects oversized local responses', async () => {
    const absent = await endpoint();
    await expect(
      createLocalRpcFetch(absent)(
        new Request('http://localhost/rpc/ping', { method: 'POST', body: 'x'.repeat(5000) }),
      ),
    ).rejects.toBeInstanceOf(CoreRpcTransportError);
    await expect(
      createLocalRpcFetch(absent)(new Request('http://localhost/rpc/ping')),
    ).rejects.toBeInstanceOf(ServiceNotRunningError);
    await expect(new CoreRpcClient(absent).ping()).rejects.toBeInstanceOf(ServiceNotRunningError);

    const oversized = await endpoint();
    const server = http.createServer((_request, response) => {
      response.end('x'.repeat(1024 * 1024 + 1));
    });
    await new Promise<void>((resolve) => server.listen(oversized, resolve));
    closeables.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
    await expect(
      createLocalRpcFetch(oversized)(new Request('http://localhost/rpc/ping')),
    ).rejects.toBeInstanceOf(CoreRpcTransportError);

    const malformed = await endpoint();
    const malformedServer = http.createServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end('{not-json');
    });
    await new Promise<void>((resolve) => malformedServer.listen(malformed, resolve));
    closeables.push({
      close: () => new Promise<void>((resolve) => malformedServer.close(() => resolve())),
    });
    await expect(new CoreRpcClient(malformed).ping()).rejects.toThrow();
  });

  it('cancels and times out stalled RPC requests over the private endpoint', async () => {
    const socketPath = await endpoint();
    let onRequest: (() => void) | undefined;
    const server = http.createServer(() => onRequest?.());
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    closeables.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });

    const controller = new AbortController();
    onRequest = () => controller.abort();
    await expect(
      createLocalRpcFetch(socketPath)(
        new Request('http://localhost/rpc/ping', { signal: controller.signal }),
      ),
    ).rejects.toThrow('cancelled');

    onRequest = undefined;
    await expect(
      createLocalRpcFetch(socketPath, 100)(new Request('http://localhost/rpc/ping')),
    ).rejects.toThrow('timed out');
  });

  it('reflects remote gateway mutations in the management status endpoint', async () => {
    const socketPath = await endpoint();
    let gatewayPort: number | null = null;
    const dependencies: CoreDependencies = {
      enableFileLogging: () => {},
      loadConfig: () => ({
        ...DEFAULT_APP_CONFIG,
        proxy: { ...DEFAULT_APP_CONFIG.proxy, auto_start: false },
      }),
      initializeAccounts: async () => {},
      initializeLocalDatabase: () => {},
      startGateway: async (config) => ({
        success: true,
        port: config.port,
        base_url: `http://localhost:${config.port}`,
      }),
      startGatewayOnPort: async (port) => {
        gatewayPort = port;
        return { success: true, port, base_url: `http://localhost:${port}` };
      },
      stopGateway: async () => {
        gatewayPort = null;
        return true;
      },
      getGatewayStatus: async () => ({
        running: gatewayPort !== null,
        port: gatewayPort ?? 0,
        base_url: gatewayPort === null ? '' : `http://localhost:${gatewayPort}`,
        active_accounts: 0,
      }),
    };
    const core = new CoreService(dependencies);
    await core.start();
    const server = new ManagementServer({
      endpoint: socketPath,
      getStatus: () => core.getStatus(),
      shutdown: async () => {},
      onShutdownError: vi.fn(),
      rpc: createCoreRpcOperations(core),
    });
    closeables.push(server);
    await server.start();
    const rpc = new CoreRpcClient(socketPath);
    const management = new ManagementClient(socketPath);

    expect(await rpc.startGateway(8125)).toEqual({
      success: true,
      port: 8125,
      base_url: 'http://localhost:8125',
    });
    expect((await management.status()).gateway).toEqual({ running: true, port: 8125 });
    expect(await rpc.stopGateway()).toEqual({ success: true });
    expect((await management.status()).gateway).toEqual({ running: false, port: null });
    await core.stop();
  });
});
