import { agentToolsOwner } from '@/modules/proxy-gateway/agent-tools/agent-tools.owner';
import { auditFileOwner } from '@/modules/proxy-gateway/audit/audit-file-owner.service';
import { ipcCaptureOwner } from '@/modules/proxy-gateway/audit/ipc-capture-owner';
import { auditOwner } from '@/modules/proxy-gateway/audit/audit-owner.service';
import { auditCurlOwner } from '@/modules/proxy-gateway/traffic-monitor/audit-curl-owner.service';
import { thoughtOwner } from '@/modules/proxy-gateway/thought-store/thought-owner.service';
import { openCodeOwner } from '@/modules/proxy-gateway/opencode-sync/opencode-owner.service';
import { localAccountOwner } from '@/modules/account/services/local-account-owner.service';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRouterClient } from '@orpc/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagementServer } from '@/core/management/server';
import { ServiceNotRunningError } from '@/core/management/client';
import { CoreRpcClient } from '@/core/rpc/client';
import { CoreRpcTransportError } from '@/core/rpc/local-fetch';
import type { CoreRpcOperations } from '@/core/rpc/router';
import { getContextCacheStatus, getGatewayStatus } from '@/modules/proxy-gateway/ipc/handlers';
import {
  getGatewayAdapter,
  selectGatewayAdapter,
} from '@/modules/proxy-gateway/ipc/gateway-adapter';
import { gatewayRouter } from '@/modules/proxy-gateway/ipc/router';
import { gatewayLifecycleService } from '@/modules/proxy-gateway/services/gateway-lifecycle.service';

vi.mock('@/modules/proxy-gateway/traffic-monitor/copy-audit-curl', () => ({
  copyAuditCurl: vi.fn(),
}));

const closeables: Array<{ close(): Promise<void> }> = [];
const directories: string[] = [];
const rendererGateway = createRouterClient(gatewayRouter);

async function endpoint(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-gateway-read-'));
  directories.push(directory);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\agm-gateway-read-${path.basename(directory)}`
    : path.join(directory, 'core.sock');
}

afterEach(async () => {
  selectGatewayAdapter({ mode: 'desktop-embedded' });
  vi.restoreAllMocks();
  await Promise.all(closeables.splice(0).map((server) => server.close()));
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('Electron gateway read adapter', () => {
  it('keeps the existing renderer reads on the embedded implementation by default', async () => {
    expect(await rendererGateway.status()).toEqual(await getGatewayStatus());
    expect(await rendererGateway.contextCacheStats()).toEqual(getContextCacheStatus());
  });

  it('preserves the embedded renderer start and stop results', async () => {
    const start = vi.spyOn(gatewayLifecycleService, 'start').mockResolvedValue({
      success: true,
      port: 8126,
      base_url: 'http://localhost:8126',
    });
    const stop = vi
      .spyOn(gatewayLifecycleService, 'stop')
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    expect(await rendererGateway.start({ port: 8126 })).toEqual({
      success: true,
      port: 8126,
      base_url: 'http://localhost:8126',
    });
    expect(await rendererGateway.stop()).toEqual({ success: true });
    await expect(rendererGateway.stop()).rejects.toThrow('Failed to stop gateway');
    expect(start).toHaveBeenCalledWith(8126);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('routes pilot renderer reads through the real private core RPC transport', async () => {
    const socketPath = await endpoint();
    const status = {
      running: true,
      port: 8045,
      base_url: 'http://localhost:8045',
      active_accounts: 2,
    };
    const cache = {
      enabled: true,
      stats: {
        activeEntries: 1,
        creationFailures: 0,
        creations: 2,
        hits: 3,
        invalidations: 0,
        lookups: 4,
      },
    };
    const operations: CoreRpcOperations = {
      diagnosticLogs: vi.fn(),
      errorReporting: { setEnabled: vi.fn() },
      auditFile: auditFileOwner,
      ipcCapture: ipcCaptureOwner,
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
      gatewayStatus: vi.fn(async () => status),
      contextCacheStatus: vi.fn(() => cache),
      accountSummaries: vi.fn(async () => []),
      accountViews: vi.fn(async () => []),
      accountSecurityStatus: vi.fn(() => ({ state: 'secure' as const })),
      accountValidationUrl: vi.fn(async () => ({ url: 'https://accounts.google.com/verify' })),
      accountSyncFromIde: vi.fn(async () => null),
      localImport: {
        preview: vi.fn(),
        confirm: vi.fn(),
        discard: vi.fn(),
        getPostImportStatus: vi.fn(),
      },
      accountSwitchStatus: vi.fn(),
      accountEvents: () => ({
        epoch: '11111111-1111-4111-8111-111111111111',
        latest: 0,
        events: [],
      }),
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
      accountProfileGet: vi.fn(async () => ({ history: [] })),
      accountProfilePreview: vi.fn(async () => ({
        machineId: 'machine',
        macMachineId: 'mac',
        devDeviceId: 'device',
        sqmId: '{SQM}',
      })),
      accountProfileBind: vi.fn(async () => ({
        machineId: 'machine',
        macMachineId: 'mac',
        devDeviceId: 'device',
        sqmId: '{SQM}',
      })),
      accountProfileBindPayload: vi.fn(async () => ({
        machineId: 'machine',
        macMachineId: 'mac',
        devDeviceId: 'device',
        sqmId: '{SQM}',
      })),
      accountProfileRestoreRevision: vi.fn(async () => ({
        machineId: 'machine',
        macMachineId: 'mac',
        devDeviceId: 'device',
        sqmId: '{SQM}',
      })),
      accountProfileRestoreBaseline: vi.fn(async () => ({
        machineId: 'machine',
        macMachineId: 'mac',
        devDeviceId: 'device',
        sqmId: '{SQM}',
      })),
      accountProfileDeleteRevision: vi.fn(async () => ({ success: true as const })),
      accountRefreshQuota: vi.fn(async () => ({
        id: 'account-1',
        provider: 'google' as const,
        email: 'example@example.com',
        created_at: 1,
        last_used: 1,
        proxy_configured: false,
      })),
      accountSetProxy: vi.fn(async () => ({ success: true as const })),
      accountDelete: vi.fn(async () => ({ success: true as const })),
      oauthClientList: vi.fn(() => []),
      oauthClientActive: vi.fn(() => ({ client_key: 'test-client' })),
      oauthClientSet: vi.fn(() => ({ success: true as const })),
      gatewayStart: vi.fn(async (port) => ({
        success: true as const,
        port,
        base_url: `http://localhost:${port}`,
      })),
      gatewayStop: vi.fn(async () => ({ success: true as const })),
    };
    const server = new ManagementServer({
      endpoint: socketPath,
      getStatus: () => ({ state: 'running', pid: 123, gateway: { running: true, port: 8045 } }),
      shutdown: async () => {},
      onShutdownError: vi.fn(),
      rpc: operations,
    });
    closeables.push(server);
    await server.start();
    selectGatewayAdapter({ mode: 'standalone-core', client: new CoreRpcClient(socketPath) });

    expect(await rendererGateway.status()).toEqual(status);
    expect(await rendererGateway.contextCacheStats()).toEqual(cache);
    expect(await rendererGateway.start({ port: 8046 })).toEqual({
      success: true,
      port: 8046,
      base_url: 'http://localhost:8046',
    });
    expect(await rendererGateway.stop()).toEqual({ success: true });
    expect(operations.gatewayStatus).toHaveBeenCalledTimes(1);
    expect(operations.contextCacheStatus).toHaveBeenCalledTimes(1);
    expect(operations.gatewayStart).toHaveBeenCalledWith(8046);
    expect(operations.gatewayStop).toHaveBeenCalledTimes(1);
  }, 15_000);

  it.each([new ServiceNotRunningError(), new CoreRpcTransportError('Malformed core RPC response')])(
    'does not fall back to embedded reads when remote mode fails: %s',
    async (error) => {
      selectGatewayAdapter({
        mode: 'standalone-core',
        client: {
          gatewayStatus: vi.fn(async () => {
            throw error;
          }),
          contextCacheStatus: vi.fn(async () => {
            throw error;
          }),
          startGateway: vi.fn(async () => {
            throw error;
          }),
          stopGateway: vi.fn(async () => {
            throw error;
          }),
        },
      });

      await expect(getGatewayAdapter().status()).rejects.toBe(error);
      await expect(rendererGateway.status()).rejects.toThrow(error.message);
      await expect(rendererGateway.contextCacheStats()).rejects.toThrow(error.message);
      await expect(rendererGateway.start({ port: 8046 })).rejects.toThrow(error.message);
      await expect(rendererGateway.stop()).rejects.toThrow(error.message);
    },
  );
});
