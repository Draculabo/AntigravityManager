import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { shell } from 'electron';
import { createRouterClient } from '@orpc/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagementServer } from '@/core/management/server';
import { ManagementClient, ServiceNotRunningError } from '@/core/management/client';
import { CoreRpcClient } from '@/core/rpc/client';
import { CoreRpcTransportError } from '@/core/rpc/local-fetch';
import { createCoreRpcOperations } from '@/core/rpc/router';
import {
  getCloudAccountAdapter,
  selectCloudAccountAdapter,
} from '@/modules/cloud-account/ipc/cloud-account-adapter';
import { cloudRouter } from '@/modules/cloud-account/ipc/router';
import {
  cloudAccountListService,
  createCloudAccountListService,
} from '@/modules/cloud-account/services/cloud-account-list.service';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import { projectCloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { IdeAccountImportAdapter } from '@/modules/cloud-account/persistence/ide-account-import-adapter';
import type { CloudAccount } from '@/modules/cloud-account/types';
import * as oauthSettings from '@/modules/cloud-account/services/cloud-account-oauth-settings.service';
import * as quotaService from '@/modules/cloud-account/services/cloud-account-quota-refresh.service';
import { cloudAccountWeeklyWarmupRunner } from '@/modules/cloud-account/services/cloud-account-weekly-warmup-runner';
import { WeeklyWarmupService } from '@/modules/cloud-account/services/WeeklyWarmupService';
import { CloudAccountSettingsStore } from '@/modules/cloud-account/persistence/cloud-account-settings-store';
import { readIdeAccountSyncErrorCode } from '@/modules/cloud-account/services/ide-account-sync.schema';
import { updateTrayMenu } from '@/modules/app-shell/ipc/tray/handler';
import { readAccountValidationLinkErrorCode } from '@/modules/cloud-account/services/account-validation-link.schema';
import { desktopOAuthLogin } from '@/modules/cloud-account/ipc/desktop-oauth-login';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));
vi.mock('@/modules/cloud-account/ipc/handler', () => ({}));
vi.mock('@/modules/app-shell/ipc/tray/handler', () => ({ updateTrayMenu: vi.fn() }));

const closeables: Array<{ close(): Promise<void> }> = [];
const directories: string[] = [];
const rendererCloud = createRouterClient(cloudRouter);

const view: CloudAccountView = {
  id: 'account-1',
  provider: 'google',
  email: 'example@example.com',
  quota: { models: { gemini: { percentage: 50, resetTime: 'later' } } },
  created_at: 1,
  last_used: 2,
  is_active: true,
  is_active_ide: true,
  proxy_configured: true,
};

async function endpoint(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-account-read-'));
  directories.push(directory);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\agm-account-read-${path.basename(directory)}`
    : path.join(directory, 'core.sock');
}

afterEach(async () => {
  selectCloudAccountAdapter({ mode: 'desktop-embedded' });
  vi.restoreAllMocks();
  vi.mocked(shell.openExternal).mockClear();
  cloudAccountWeeklyWarmupRunner.start();
  await Promise.all(closeables.splice(0).map((server) => server.close()));
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('cloud account read adapter', () => {
  it('routes login through the selected remote owner and keeps the renderer result strict', async () => {
    const socketPath = await endpoint();
    const loginView = { ...view, id: '11111111-1111-4111-8111-111111111111' };
    const oauth = {
      start: vi.fn(async (key?: string) => ({
        sessionId: '11111111-1111-4111-8111-111111111111',
        authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?client=${key}`,
      })),
      status: vi.fn(() => ({
        state: 'succeeded' as const,
        account: { id: loginView.id, email: loginView.email },
      })),
      cancel: vi.fn(async () => {}),
      completeCode: vi.fn(() => true),
    };
    const server = new ManagementServer({
      endpoint: socketPath,
      getStatus: () => ({ state: 'running', pid: 123, gateway: { running: false, port: null } }),
      shutdown: async () => {},
      onShutdownError: vi.fn(),
      oauth,
      rpc: createCoreRpcOperations({
        startGateway: vi.fn(async (port: number) => ({
          success: true as const,
          port,
          base_url: '',
        })),
        stopGateway: vi.fn(async () => true),
      }),
    });
    closeables.push(server);
    await server.start();
    const client = new CoreRpcClient(socketPath);
    vi.spyOn(cloudAccountListService, 'listViews').mockResolvedValue([loginView]);
    vi.spyOn(client, 'setActiveOAuthClient').mockResolvedValue();
    const embeddedStart = vi.spyOn(desktopOAuthLogin, 'start');
    selectCloudAccountAdapter({
      mode: 'standalone-core',
      client,
      management: new ManagementClient(socketPath),
    });

    expect(await rendererCloud.startAuthFlow({ oauthClientKey: 'remote-client' })).toEqual(
      loginView,
    );
    expect(oauth.start).toHaveBeenCalledExactlyOnceWith('remote-client');
    expect(client.setActiveOAuthClient).toHaveBeenCalledExactlyOnceWith('remote-client');
    expect(shell.openExternal).toHaveBeenCalledWith(
      'https://accounts.google.com/o/oauth2/v2/auth?client=remote-client',
    );
    expect(embeddedStart).not.toHaveBeenCalled();
    expect(JSON.stringify(loginView)).not.toMatch(/sessionId|authorizationUrl|access_token/);
  });

  it('does not fall back to embedded enrollment when remote login is unavailable', async () => {
    const socketPath = await endpoint();
    const client = new CoreRpcClient(socketPath);
    const embeddedStart = vi.spyOn(desktopOAuthLogin, 'start');
    selectCloudAccountAdapter({
      mode: 'standalone-core',
      client,
      management: new ManagementClient(socketPath),
    });

    await expect(rendererCloud.startAuthFlow()).rejects.toMatchObject({
      data: { loginCode: 'login-failed' },
    });
    expect(embeddedStart).not.toHaveBeenCalled();
  });

  it('reports plaintext account storage and opens trusted validation URLs only in Electron main', async () => {
    const stored: CloudAccount = {
      id: 'validated-account',
      provider: 'google',
      email: 'validated@example.com',
      token: {
        access_token: 'private-access-token',
        refresh_token: 'private-refresh-token',
        expires_in: 3600,
        expiry_timestamp: 3600,
        token_type: 'Bearer',
      },
      health: {
        validation: {
          status: 'requires_action',
          reason: 'VALIDATION_REQUIRED',
          detected_at_ms: 1,
          next_probe_at_ms: 2,
          verification_url: 'https://accounts.google.com/verify?id=1',
        },
      },
      created_at: 1,
      last_used: 2,
    };
    const getAccount = vi.spyOn(CloudAccountRepo, 'getAccount').mockResolvedValue(stored);

    expect(await rendererCloud.getSecurityStatus()).toEqual({ state: 'plaintext' });
    expect(await rendererCloud.openAccountValidationLink({ accountId: stored.id })).toBeUndefined();
    expect(shell.openExternal).toHaveBeenCalledWith('https://accounts.google.com/verify?id=1');

    const socketPath = await endpoint();
    const server = new ManagementServer({
      endpoint: socketPath,
      getStatus: () => ({ state: 'running', pid: 123, gateway: { running: false, port: null } }),
      shutdown: async () => {},
      onShutdownError: vi.fn(),
      rpc: createCoreRpcOperations({
        startGateway: vi.fn(async (port: number) => ({
          success: true as const,
          port,
          base_url: '',
        })),
        stopGateway: vi.fn(async () => true),
      }),
    });
    closeables.push(server);
    await server.start();
    const client = new CoreRpcClient(socketPath);
    selectCloudAccountAdapter({ mode: 'standalone-core', client });
    expect(await rendererCloud.getSecurityStatus()).toEqual({ state: 'plaintext' });
    expect(await client.resolveAccountValidationUrl(stored.id)).toBe(
      'https://accounts.google.com/verify?id=1',
    );
    expect(await rendererCloud.openAccountValidationLink({ accountId: stored.id })).toBeUndefined();
    expect(shell.openExternal).toHaveBeenCalledTimes(2);
    expect(getAccount).toHaveBeenCalledTimes(3);
  }, 15_000);

  it('returns stable validation-link failures without exposing stored URLs', async () => {
    const getAccount = vi.spyOn(CloudAccountRepo, 'getAccount');
    const socketPath = await endpoint();
    const server = new ManagementServer({
      endpoint: socketPath,
      getStatus: () => ({ state: 'running', pid: 123, gateway: { running: false, port: null } }),
      shutdown: async () => {},
      onShutdownError: vi.fn(),
      rpc: createCoreRpcOperations({
        startGateway: vi.fn(async (port: number) => ({
          success: true as const,
          port,
          base_url: '',
        })),
        stopGateway: vi.fn(async () => true),
      }),
    });
    closeables.push(server);
    await server.start();
    const cases = [
      ['account-not-found', undefined],
      [
        'no-trusted-link',
        {
          id: 'account-1',
          provider: 'google',
          email: 'example@example.com',
          token: {
            access_token: 'private-access',
            refresh_token: 'private-refresh',
            expires_in: 3600,
            expiry_timestamp: 3600,
            token_type: 'Bearer',
          },
          health: {
            validation: {
              status: 'requires_action',
              reason: 'VALIDATION_REQUIRED',
              detected_at_ms: 1,
              next_probe_at_ms: 2,
              verification_url: 'https://evil.example/private-token',
            },
          },
          created_at: 1,
          last_used: 2,
        } satisfies CloudAccount,
      ],
    ] as const;
    for (const mode of ['desktop-embedded', 'standalone-core'] as const) {
      if (mode === 'standalone-core') {
        selectCloudAccountAdapter({ mode, client: new CoreRpcClient(socketPath) });
      }
      for (const [validationCode, account] of cases) {
        getAccount.mockResolvedValueOnce(account);
        try {
          await rendererCloud.openAccountValidationLink({ accountId: 'account-1' });
          expect.fail('Validation action should reject');
        } catch (error) {
          expect(readAccountValidationLinkErrorCode(error)).toBe(validationCode);
          expect(JSON.stringify(error)).not.toMatch(/private-token|private-access|evil\.example/);
        }
      }
    }
    expect(shell.openExternal).not.toHaveBeenCalled();
  }, 15_000);

  it('rejects an untrusted remote validation URL before invoking the system browser', async () => {
    const client = new CoreRpcClient(await endpoint());
    vi.spyOn(client, 'resolveAccountValidationUrl').mockResolvedValue(
      'https://evil.example/private-token',
    );
    selectCloudAccountAdapter({ mode: 'standalone-core', client });

    await expect(
      rendererCloud.openAccountValidationLink({ accountId: 'account-1' }),
    ).rejects.toMatchObject({ data: { validationCode: 'validation-link-failed' } });
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it('keeps IDE sync views strict in embedded and remote mode over the private pipe', async () => {
    const stored: CloudAccount = {
      id: 'synced-account',
      provider: 'google',
      email: 'synced@example.com',
      token: {
        access_token: 'private-access-token',
        refresh_token: 'private-refresh-token',
        expires_in: 3600,
        expiry_timestamp: 3600,
        token_type: 'Bearer',
      },
      proxy_url: 'http://user:password@127.0.0.1:7890',
      created_at: 1,
      last_used: 2,
    };
    const sync = vi.spyOn(IdeAccountImportAdapter, 'syncFromIde').mockResolvedValue(stored);
    vi.spyOn(cloudAccountListService, 'listViews').mockImplementation(async () => [
      projectCloudAccountView(stored),
    ]);
    const embedded = await rendererCloud.syncLocalAccount({ appTarget: 'ide' });
    expect(embedded).toEqual(projectCloudAccountView(stored));
    expect(sync).toHaveBeenCalledWith('ide');

    const socketPath = await endpoint();
    const server = new ManagementServer({
      endpoint: socketPath,
      getStatus: () => ({ state: 'running', pid: 123, gateway: { running: false, port: null } }),
      shutdown: async () => {},
      onShutdownError: vi.fn(),
      rpc: createCoreRpcOperations({
        startGateway: vi.fn(async (port: number) => ({
          success: true as const,
          port,
          base_url: '',
        })),
        stopGateway: vi.fn(async () => true),
      }),
    });
    closeables.push(server);
    await server.start();
    selectCloudAccountAdapter({ mode: 'standalone-core', client: new CoreRpcClient(socketPath) });

    const remote = await rendererCloud.syncLocalAccount({ appTarget: 'classic' });
    expect(remote).toEqual(embedded);
    expect(sync.mock.calls).toEqual([['ide'], ['classic']]);
    expect(await rendererCloud.listCloudAccounts()).toEqual([remote]);
    expect(JSON.stringify(remote)).not.toMatch(
      /private-access|private-refresh|user:password|proxy_url/,
    );
    sync.mockResolvedValueOnce(null);
    expect(await rendererCloud.syncLocalAccount()).toBeNull();
    expect(sync).toHaveBeenLastCalledWith(undefined);
  }, 15_000);

  it('returns stable IDE sync errors without provider details over the private pipe', async () => {
    const sync = vi.spyOn(IdeAccountImportAdapter, 'syncFromIde');
    const socketPath = await endpoint();
    const server = new ManagementServer({
      endpoint: socketPath,
      getStatus: () => ({ state: 'running', pid: 123, gateway: { running: false, port: null } }),
      shutdown: async () => {},
      onShutdownError: vi.fn(),
      rpc: createCoreRpcOperations({
        startGateway: vi.fn(async (port: number) => ({
          success: true as const,
          port,
          base_url: '',
        })),
        stopGateway: vi.fn(async () => true),
      }),
    });
    closeables.push(server);
    await server.start();

    const cases = [
      ['reauth-required', 'Please re-login in Antigravity IDE. private-access-token'],
      ['no-ide-account', 'No cloud account found in IDE. private-access-token'],
      ['ide-database-unavailable', 'Antigravity database not found at C:\\private\\account.db'],
      [
        'agy-unsupported',
        'Antigravity CLI accounts are stored in the system credential store and cannot be synced from IDE SQLite state.',
      ],
      ['sync-failed', 'Provider returned private-access-token'],
    ] as const;

    for (const mode of ['desktop-embedded', 'standalone-core'] as const) {
      if (mode === 'standalone-core') {
        selectCloudAccountAdapter({ mode, client: new CoreRpcClient(socketPath) });
      }
      for (const [syncCode, rawMessage] of cases) {
        sync.mockRejectedValueOnce(new Error(rawMessage));
        try {
          await rendererCloud.syncLocalAccount({ appTarget: 'ide' });
          expect.fail('IDE sync should reject');
        } catch (error) {
          expect(readIdeAccountSyncErrorCode(error)).toBe(syncCode);
          expect(String(error)).not.toContain('private-access-token');
          expect(String(error)).not.toContain('C:\\private\\account.db');
          expect(JSON.stringify(error)).not.toMatch(
            /private-access-token|account\.db|backendStack/,
          );
        }
      }
    }
    expect(sync).toHaveBeenCalledTimes(cases.length * 2);
  }, 15_000);

  it('drains an admitted IDE sync before core ownership closes', async () => {
    let finishSync: (account: CloudAccount | null) => void = () => {};
    const waiting = new Promise<CloudAccount | null>((resolve) => {
      finishSync = resolve;
    });
    vi.spyOn(IdeAccountImportAdapter, 'syncFromIde').mockImplementation(() => waiting);
    const operations = createCoreRpcOperations({
      startGateway: vi.fn(async (port: number) => ({ success: true as const, port, base_url: '' })),
      stopGateway: vi.fn(async () => true),
    });
    const pending = operations.accountSyncFromIde('ide');
    operations.closeAccountMutationAdmission();
    let drained = false;
    const draining = operations.drainAccountMutations().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    await expect(operations.accountSyncFromIde('ide')).rejects.toThrow('shutting down');
    finishSync(null);
    expect(await pending).toBeNull();
    await draining;
    expect(drained).toBe(true);
  });

  it('keeps embedded and private-pipe quota refresh views strict and schedules warmup', async () => {
    const stored: CloudAccount = {
      id: 'refresh-account',
      provider: 'google',
      email: 'refresh@example.com',
      token: {
        access_token: 'private-access-token',
        refresh_token: 'private-refresh-token',
        expires_in: 3600,
        expiry_timestamp: 3600,
        token_type: 'Bearer',
      },
      proxy_url: 'http://user:password@127.0.0.1:7890',
      quota: { models: { gemini: { percentage: 40, resetTime: 'later' } } },
      created_at: 1,
      last_used: 2,
    };
    const refresh = vi
      .spyOn(quotaService, 'refreshAccountQuotaCore')
      .mockImplementation(async (_accountId, hooks) => {
        stored.quota = { models: { gemini: { percentage: 90, resetTime: 'soon' } } };
        hooks?.onPrimarySuccess?.(stored);
        return stored;
      });
    const warmup = vi
      .spyOn(cloudAccountWeeklyWarmupRunner, 'schedule')
      .mockImplementation(() => {});
    vi.spyOn(CloudAccountSettingsStore, 'getSetting').mockReturnValue('en');
    vi.spyOn(cloudAccountListService, 'listViews').mockImplementation(async () => [
      projectCloudAccountView(stored),
    ]);

    const embedded = await rendererCloud.refreshAccountQuota({ accountId: stored.id });
    expect(embedded).toEqual(projectCloudAccountView(stored));
    expect(updateTrayMenu).toHaveBeenCalledOnce();
    expect(warmup).toHaveBeenCalledWith([stored]);

    const socketPath = await endpoint();
    const server = new ManagementServer({
      endpoint: socketPath,
      getStatus: () => ({ state: 'running', pid: 123, gateway: { running: false, port: null } }),
      shutdown: async () => {},
      onShutdownError: vi.fn(),
      rpc: createCoreRpcOperations({
        startGateway: vi.fn(async (port: number) => ({
          success: true as const,
          port,
          base_url: `http://localhost:${port}`,
        })),
        stopGateway: vi.fn(async () => true),
      }),
    });
    closeables.push(server);
    await server.start();
    selectCloudAccountAdapter({ mode: 'standalone-core', client: new CoreRpcClient(socketPath) });

    const remote = await rendererCloud.refreshAccountQuota({ accountId: stored.id });
    expect(remote).toEqual(embedded);
    expect(await rendererCloud.listCloudAccounts()).toEqual([remote]);
    expect(updateTrayMenu).toHaveBeenCalledOnce();
    expect(warmup).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(remote)).not.toMatch(
      /private-access|private-refresh|user:password|proxy_url/,
    );
  }, 15_000);

  it('schedules core warmup on retry success but not on results without a success hook', async () => {
    const stored: CloudAccount = {
      id: 'refresh-account',
      provider: 'google',
      email: 'refresh@example.com',
      token: {
        access_token: 'private-access-token',
        refresh_token: 'private-refresh-token',
        expires_in: 3600,
        expiry_timestamp: 3600,
        token_type: 'Bearer',
      },
      quota: { models: { gemini: { percentage: 40, resetTime: 'later' } } },
      created_at: 1,
      last_used: 2,
    };
    const schedule = vi
      .spyOn(cloudAccountWeeklyWarmupRunner, 'schedule')
      .mockImplementation(() => {});
    const refresh = vi.spyOn(quotaService, 'refreshAccountQuotaCore');
    const operations = createCoreRpcOperations({
      startGateway: vi.fn(async (port: number) => ({ success: true as const, port, base_url: '' })),
      stopGateway: vi.fn(async () => true),
    });

    refresh.mockImplementationOnce(async (_accountId, hooks) => {
      hooks?.onRetrySuccess?.(stored);
      return stored;
    });
    expect(await operations.accountRefreshQuota(stored.id)).toEqual(
      projectCloudAccountView(stored),
    );
    expect(schedule).toHaveBeenCalledExactlyOnceWith([stored]);

    refresh.mockResolvedValueOnce(stored).mockResolvedValueOnce(stored);
    expect(await operations.accountRefreshQuota(stored.id)).toEqual(
      projectCloudAccountView(stored),
    );
    expect(await operations.accountRefreshQuota(stored.id)).toEqual(
      projectCloudAccountView(stored),
    );
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it('does not start warmup when an in-flight core refresh completes after cancellation', async () => {
    const stored: CloudAccount = {
      id: 'refresh-account',
      provider: 'google',
      email: 'refresh@example.com',
      token: {
        access_token: 'private-access-token',
        refresh_token: 'private-refresh-token',
        expires_in: 3600,
        expiry_timestamp: 3600,
        token_type: 'Bearer',
      },
      created_at: 1,
      last_used: 2,
    };
    let finishRefresh: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    vi.spyOn(quotaService, 'refreshAccountQuotaCore').mockImplementation(
      async (_accountId, hooks) => {
        await waiting;
        hooks?.onPrimarySuccess?.(stored);
        return stored;
      },
    );
    const run = vi.spyOn(WeeklyWarmupService, 'run');
    const operations = createCoreRpcOperations({
      startGateway: vi.fn(async (port: number) => ({ success: true as const, port, base_url: '' })),
      stopGateway: vi.fn(async () => true),
    });

    const pending = operations.accountRefreshQuota(stored.id);
    operations.closeAccountMutationAdmission();
    let drained = false;
    const draining = operations.drainAccountMutations().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    await expect(operations.accountRefreshQuota(stored.id)).rejects.toThrow('shutting down');
    cloudAccountWeeklyWarmupRunner.cancel();
    finishRefresh();
    expect(await pending).toEqual(projectCloudAccountView(stored));
    await draining;
    expect(drained).toBe(true);
    await cloudAccountWeeklyWarmupRunner.drain();
    expect(run).not.toHaveBeenCalled();
  });

  it('uses the shared list service for the embedded renderer route by default', async () => {
    const listViews = vi.spyOn(cloudAccountListService, 'listViews').mockResolvedValue([view]);

    expect(await rendererCloud.listCloudAccounts()).toEqual([view]);
    expect(listViews).toHaveBeenCalledOnce();
  });

  it('preserves embedded/remote payload parity over the private pipe', async () => {
    const listViews = vi.spyOn(cloudAccountListService, 'listViews').mockResolvedValue([view]);
    const embeddedLogin = vi.spyOn(desktopOAuthLogin, 'start');
    const embedded = await rendererCloud.listCloudAccounts();
    const socketPath = await endpoint();
    const operations = createCoreRpcOperations({
      startGateway: vi.fn(async (port: number) => ({
        success: true as const,
        port,
        base_url: `http://localhost:${port}`,
      })),
      stopGateway: vi.fn(async () => true),
    });
    const server = new ManagementServer({
      endpoint: socketPath,
      getStatus: () => ({ state: 'running', pid: 123, gateway: { running: false, port: null } }),
      shutdown: async () => {},
      onShutdownError: vi.fn(),
      rpc: operations,
    });
    closeables.push(server);
    await server.start();
    selectCloudAccountAdapter({ mode: 'standalone-core', client: new CoreRpcClient(socketPath) });

    expect(await rendererCloud.listCloudAccounts()).toEqual(embedded);
    selectCloudAccountAdapter({ mode: 'desktop-embedded' });
    expect(await rendererCloud.listCloudAccounts()).toEqual(embedded);
    expect(listViews).toHaveBeenCalledTimes(3);
    expect(embeddedLogin).not.toHaveBeenCalled();
  }, 15_000);

  it('routes proxy replacement, removal and deletion through the selected owner', async () => {
    const account: CloudAccount = {
      id: 'account-1',
      provider: 'google',
      email: 'example@example.com',
      token: {
        access_token: 'test-access',
        refresh_token: 'test-refresh',
        expires_in: 3600,
        expiry_timestamp: 1000,
        token_type: 'Bearer',
      },
      created_at: 1,
      last_used: 2,
    };
    let storedAccounts = [account];
    const setProxy = vi
      .spyOn(CloudAccountRepo, 'setAccountProxy')
      .mockImplementation((_id, url) => {
        storedAccounts[0].proxy_url = url ?? undefined;
      });
    const removeAccount = vi
      .spyOn(CloudAccountRepo, 'removeAccount')
      .mockImplementation(async () => {
        storedAccounts = [];
      });
    const listService = createCloudAccountListService({
      getAccounts: async () => storedAccounts,
      backfillOAuthClientKeys: async () => false,
      refreshProcessCache: async () => {},
      getCurrentAccountInfo: () => ({ isAuthenticated: false, email: '' }),
      usesCredentialStore: () => false,
      getActiveAccountId: () => '',
      warn: vi.fn(),
    });
    vi.spyOn(cloudAccountListService, 'listViews').mockImplementation(listService.listViews);
    const socketPath = await endpoint();
    const server = new ManagementServer({
      endpoint: socketPath,
      getStatus: () => ({ state: 'running', pid: 123, gateway: { running: false, port: null } }),
      shutdown: async () => {},
      onShutdownError: vi.fn(),
      rpc: createCoreRpcOperations({
        startGateway: vi.fn(async (port: number) => ({
          success: true as const,
          port,
          base_url: `http://localhost:${port}`,
        })),
        stopGateway: vi.fn(async () => true),
      }),
    });
    closeables.push(server);
    await server.start();
    const proxyUrl = 'http://proxy-user:proxy-password@127.0.0.1:7890';

    await rendererCloud.setAccountProxy({ accountId: 'account-1', proxyUrl });
    expect((await rendererCloud.listCloudAccounts())[0]?.proxy_configured).toBe(true);
    await rendererCloud.setAccountProxy({ accountId: 'account-1', proxyUrl: null });
    expect((await rendererCloud.listCloudAccounts())[0]?.proxy_configured).toBe(false);
    await rendererCloud.deleteCloudAccount({ accountId: 'account-1' });
    expect(await rendererCloud.listCloudAccounts()).toEqual([]);
    expect(setProxy.mock.calls).toEqual([
      ['account-1', proxyUrl],
      ['account-1', null],
    ]);
    expect(removeAccount).toHaveBeenCalledOnce();

    setProxy.mockClear();
    removeAccount.mockClear();
    storedAccounts = [account];
    selectCloudAccountAdapter({ mode: 'standalone-core', client: new CoreRpcClient(socketPath) });
    await rendererCloud.setAccountProxy({ accountId: 'account-1', proxyUrl });
    expect((await rendererCloud.listCloudAccounts())[0]?.proxy_configured).toBe(true);
    await rendererCloud.setAccountProxy({ accountId: 'account-1', proxyUrl: null });
    expect((await rendererCloud.listCloudAccounts())[0]?.proxy_configured).toBe(false);
    await rendererCloud.deleteCloudAccount({ accountId: 'account-1' });
    expect(await rendererCloud.listCloudAccounts()).toEqual([]);
    expect(setProxy.mock.calls).toEqual([
      ['account-1', proxyUrl],
      ['account-1', null],
    ]);
    expect(removeAccount).toHaveBeenCalledOnce();
  }, 15_000);

  it('rejects invalid proxy input before writing through either transport', async () => {
    const setProxy = vi.spyOn(CloudAccountRepo, 'setAccountProxy').mockImplementation(() => {});
    await expect(
      rendererCloud.setAccountProxy({ accountId: 'account-1', proxyUrl: 'invalid' }),
    ).rejects.toThrow();
    expect(setProxy).not.toHaveBeenCalled();

    const socketPath = await endpoint();
    const server = new ManagementServer({
      endpoint: socketPath,
      getStatus: () => ({ state: 'running', pid: 123, gateway: { running: false, port: null } }),
      shutdown: async () => {},
      onShutdownError: vi.fn(),
      rpc: createCoreRpcOperations({
        startGateway: vi.fn(async (port: number) => ({
          success: true as const,
          port,
          base_url: `http://localhost:${port}`,
        })),
        stopGateway: vi.fn(async () => true),
      }),
    });
    closeables.push(server);
    await server.start();
    await expect(
      new CoreRpcClient(socketPath).setAccountProxy('account-1', 'invalid'),
    ).rejects.toThrow();
    expect(setProxy).not.toHaveBeenCalled();
  }, 15_000);

  it('keeps OAuth client preference state coherent over the private pipe', async () => {
    let active = 'builtin';
    const list = vi.spyOn(oauthSettings, 'listOAuthClients').mockImplementation(() => [
      {
        key: 'builtin',
        label: 'Builtin',
        client_id: 'public-id',
        is_active: active === 'builtin',
        is_builtin: true,
      },
      {
        key: 'custom',
        label: 'Custom',
        client_id: 'custom-public-id',
        is_active: active === 'custom',
        is_builtin: false,
      },
    ]);
    const get = vi.spyOn(oauthSettings, 'getActiveOAuthClient').mockImplementation(() => active);
    const set = vi.spyOn(oauthSettings, 'setActiveOAuthClient').mockImplementation((key) => {
      active = key;
    });
    const socketPath = await endpoint();
    const server = new ManagementServer({
      endpoint: socketPath,
      getStatus: () => ({ state: 'running', pid: 123, gateway: { running: false, port: null } }),
      shutdown: async () => {},
      onShutdownError: vi.fn(),
      rpc: createCoreRpcOperations({
        startGateway: vi.fn(async (port: number) => ({
          success: true as const,
          port,
          base_url: `http://localhost:${port}`,
        })),
        stopGateway: vi.fn(async () => true),
      }),
    });
    closeables.push(server);
    await server.start();

    const embeddedClients = await rendererCloud.listOAuthClients();
    expect((await rendererCloud.getActiveOAuthClient()).client_key).toBe('builtin');
    await rendererCloud.setActiveOAuthClient({ clientKey: 'custom' });
    expect((await rendererCloud.getActiveOAuthClient()).client_key).toBe('custom');

    selectCloudAccountAdapter({ mode: 'standalone-core', client: new CoreRpcClient(socketPath) });
    expect(await rendererCloud.listOAuthClients()).toEqual(
      embeddedClients.map((client) => ({ ...client, is_active: client.key === 'custom' })),
    );
    expect((await rendererCloud.getActiveOAuthClient()).client_key).toBe('custom');
    await rendererCloud.setActiveOAuthClient({ clientKey: 'builtin' });
    expect((await rendererCloud.getActiveOAuthClient()).client_key).toBe('builtin');
    await expect(new CoreRpcClient(socketPath).setActiveOAuthClient('')).rejects.toThrow();
    expect(list).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(4);
    expect(set.mock.calls).toEqual([['custom'], ['builtin']]);
  }, 15_000);

  it.each([new ServiceNotRunningError(), new CoreRpcTransportError('Malformed core RPC response')])(
    'does not fall back to embedded account reads when remote mode fails: %s',
    async (error) => {
      const listViews = vi.spyOn(cloudAccountListService, 'listViews').mockResolvedValue([view]);
      const setProxy = vi.spyOn(CloudAccountRepo, 'setAccountProxy').mockImplementation(() => {});
      const removeAccount = vi.spyOn(CloudAccountRepo, 'removeAccount').mockResolvedValue();
      const listOAuthClients = vi.spyOn(oauthSettings, 'listOAuthClients');
      const getActiveOAuthClient = vi.spyOn(oauthSettings, 'getActiveOAuthClient');
      const setActiveOAuthClient = vi.spyOn(oauthSettings, 'setActiveOAuthClient');
      const refreshQuota = vi.spyOn(quotaService, 'refreshAccountQuotaCore');
      const syncFromIde = vi.spyOn(IdeAccountImportAdapter, 'syncFromIde');
      const getAccount = vi.spyOn(CloudAccountRepo, 'getAccount');
      selectCloudAccountAdapter({
        mode: 'standalone-core',
        client: {
          localImportPreview: vi.fn(),
          localImportConfirm: vi.fn(),
          localImportDiscard: vi.fn(),
          localImportStatus: vi.fn(),
          accountSwitchStatus: vi.fn(),
          readAccountOwnerEvents: vi.fn(async () => {
            throw error;
          }),
          getAutoSwitchEnabled: vi.fn(async () => {
            throw error;
          }),
          setAutoSwitchEnabled: vi.fn(async () => {
            throw error;
          }),
          getAutoSwitchModelsConfig: vi.fn(async () => {
            throw error;
          }),
          setAutoSwitchModelsConfig: vi.fn(async () => {
            throw error;
          }),
          forcePoll: vi.fn(async () => {
            throw error;
          }),
          getWeeklyWarmupConfig: vi.fn(async () => {
            throw error;
          }),
          setWeeklyWarmupConfig: vi.fn(async () => {
            throw error;
          }),
          importAccountFile: vi.fn(async () => {
            throw error;
          }),
          exportAccountFile: vi.fn(async () => {
            throw error;
          }),
          accountViews: vi.fn(async () => {
            throw error;
          }),
          refreshAccountQuota: vi.fn(async () => {
            throw error;
          }),
          syncFromIde: vi.fn(async () => {
            throw error;
          }),
          switchCloudAccount: vi.fn(async () => {
            throw error;
          }),
          accountSecurityStatus: vi.fn(async () => {
            throw error;
          }),
          resolveAccountValidationUrl: vi.fn(async () => {
            throw error;
          }),
          setAccountProxy: vi.fn(async () => {
            throw error;
          }),
          deleteCloudAccount: vi.fn(async () => {
            throw error;
          }),
          listOAuthClients: vi.fn(async () => {
            throw error;
          }),
          getActiveOAuthClient: vi.fn(async () => {
            throw error;
          }),
          setActiveOAuthClient: vi.fn(async () => {
            throw error;
          }),
          getIdentityProfiles: vi.fn(async () => {
            throw error;
          }),
          previewIdentityProfile: vi.fn(async () => {
            throw error;
          }),
          bindIdentityProfile: vi.fn(async () => {
            throw error;
          }),
          bindIdentityProfileWithPayload: vi.fn(async () => {
            throw error;
          }),
          restoreIdentityProfileRevision: vi.fn(async () => {
            throw error;
          }),
          restoreBaselineProfile: vi.fn(async () => {
            throw error;
          }),
          deleteIdentityProfileRevision: vi.fn(async () => {
            throw error;
          }),
        },
      });

      await expect(getCloudAccountAdapter().listViews()).rejects.toBe(error);
      await expect(getCloudAccountAdapter().getAutoSwitchEnabled()).rejects.toBe(error);
      await expect(getCloudAccountAdapter().setAutoSwitchEnabled(true)).rejects.toBe(error);
      await expect(getCloudAccountAdapter().getAutoSwitchModelsConfig()).rejects.toBe(error);
      await expect(getCloudAccountAdapter().setAutoSwitchModelsConfig({})).rejects.toBe(error);
      await expect(getCloudAccountAdapter().forcePoll()).rejects.toBe(error);
      await expect(getCloudAccountAdapter().getWeeklyWarmupConfig()).rejects.toBe(error);
      await expect(
        getCloudAccountAdapter().setWeeklyWarmupConfig({ enabled: false, groups: [] }),
      ).rejects.toBe(error);
      await expect(getCloudAccountAdapter().importFile('/selected.json', 'merge')).rejects.toBe(
        error,
      );
      await expect(getCloudAccountAdapter().exportFile('/selected.json', false)).rejects.toBe(
        error,
      );
      await expect(getCloudAccountAdapter().refreshQuota('account-1')).rejects.toBe(error);
      await expect(getCloudAccountAdapter().syncFromIde('ide')).rejects.toBe(error);
      await expect(getCloudAccountAdapter().switchAccount('account-1', 'ide')).rejects.toBe(error);
      await expect(getCloudAccountAdapter().getIdentityProfiles('account-1')).rejects.toBe(error);
      await expect(getCloudAccountAdapter().previewIdentityProfile()).rejects.toBe(error);
      await expect(
        getCloudAccountAdapter().bindIdentityProfile('account-1', 'capture'),
      ).rejects.toBe(error);
      await expect(
        getCloudAccountAdapter().bindIdentityProfileWithPayload('account-1', {
          machineId: 'machine',
          macMachineId: 'mac',
          devDeviceId: 'device',
          sqmId: '{SQM}',
        }),
      ).rejects.toBe(error);
      await expect(
        getCloudAccountAdapter().restoreIdentityProfileRevision('account-1', 'current'),
      ).rejects.toBe(error);
      await expect(getCloudAccountAdapter().restoreBaselineProfile('account-1')).rejects.toBe(
        error,
      );
      await expect(
        getCloudAccountAdapter().deleteIdentityProfileRevision('account-1', 'revision-1'),
      ).rejects.toBe(error);
      await expect(getCloudAccountAdapter().getSecurityStatus()).rejects.toBe(error);
      await expect(getCloudAccountAdapter().openValidationLink('account-1')).rejects.toBe(error);
      await expect(rendererCloud.refreshAccountQuota({ accountId: 'account-1' })).rejects.toThrow(
        error.message,
      );
      await expect(rendererCloud.listCloudAccounts()).rejects.toThrow(error.message);
      await expect(getCloudAccountAdapter().setProxy('account-1', null)).rejects.toBe(error);
      await expect(getCloudAccountAdapter().delete('account-1')).rejects.toBe(error);
      await expect(getCloudAccountAdapter().listOAuthClients()).rejects.toBe(error);
      await expect(getCloudAccountAdapter().getActiveOAuthClient()).rejects.toBe(error);
      await expect(getCloudAccountAdapter().setActiveOAuthClient('custom')).rejects.toBe(error);
      expect(listViews).not.toHaveBeenCalled();
      expect(refreshQuota).not.toHaveBeenCalled();
      expect(syncFromIde).not.toHaveBeenCalled();
      expect(getAccount).not.toHaveBeenCalled();
      expect(shell.openExternal).not.toHaveBeenCalled();
      expect(setProxy).not.toHaveBeenCalled();
      expect(removeAccount).not.toHaveBeenCalled();
      expect(listOAuthClients).not.toHaveBeenCalled();
      expect(getActiveOAuthClient).not.toHaveBeenCalled();
      expect(setActiveOAuthClient).not.toHaveBeenCalled();
    },
  );
});
