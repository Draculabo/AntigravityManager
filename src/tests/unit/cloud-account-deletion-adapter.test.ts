import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRouterClient } from '@orpc/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagementServer } from '@/core/management/server';
import { CoreRpcClient } from '@/core/rpc/client';
import { createCoreRpcOperations } from '@/core/rpc/router';
import { selectCloudAccountAdapter } from '@/modules/cloud-account/ipc/cloud-account-adapter';
import { cloudRouter } from '@/modules/cloud-account/ipc/router';
import {
  cloudAccountListService,
  createCloudAccountListService,
} from '@/modules/cloud-account/services/cloud-account-list.service';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { proxyModelAvailabilityStore } from '@/server/gateway/shared/services/model-availability.service';
import {
  createServiceConfigService,
  serviceConfigService,
} from '@/modules/config/service-config.service';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { mockCoreGatewayLifecycle } from '../support/core-gateway-lifecycle';

vi.mock('@/modules/cloud-account/ipc/handler', () => ({}));
const closeables: Array<{ close(): Promise<void> }> = [];
const directories: string[] = [];
const rendererCloud = createRouterClient(cloudRouter);
async function endpoint(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-account-delete-adapter-'));
  directories.push(directory);
  return process.platform === 'win32'
    ? '\\\\.\\pipe\\agm-account-delete-adapter-' + path.basename(directory)
    : path.join(directory, 'core.sock');
}
afterEach(async () => {
  selectCloudAccountAdapter({ mode: 'desktop-embedded' });
  await Promise.all(closeables.splice(0).map((server) => server.close()));
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

describe('cloud account deletion adapter', () => {
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
    let config = structuredClone(DEFAULT_APP_CONFIG);
    config.proxy.preferred_account_id = account.id;
    const isolatedConfig = createServiceConfigService({
      load: () => structuredClone(config),
      save: async (next) => {
        config = structuredClone(next);
      },
      apply: async () => true,
      runningPort: async () => null,
    });
    const cleanup = vi
      .spyOn(serviceConfigService, 'clearDeletedAccountPreference')
      .mockImplementation(isolatedConfig.clearDeletedAccountPreference);
    vi.spyOn(CloudAccountRepo, 'assertCurrentAccount').mockImplementation((id, guard) => {
      guard(structuredClone(storedAccounts.find((account) => account.id === id)));
    });
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
      readAgyAccountToken: async () => null,
      readSystemAccountToken: async () => null,
      isClientInstalled: () => false,
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
        ...mockCoreGatewayLifecycle(),
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
    proxyModelAvailabilityStore.mark('account-1', 'gemini-3-pro', 'model_forbidden');
    await rendererCloud.deleteCloudAccount({ accountId: 'account-1' });
    expect(proxyModelAvailabilityStore.isCapabilityBlocked('account-1', 'gemini-3-pro')).toBe(
      false,
    );
    expect(await rendererCloud.listCloudAccounts()).toEqual([]);
    expect(setProxy.mock.calls).toEqual([
      ['account-1', proxyUrl],
      ['account-1', null],
    ]);
    expect(removeAccount).toHaveBeenCalledOnce();
    expect(config.proxy.preferred_account_id).toBe('');

    setProxy.mockClear();
    removeAccount.mockClear();
    storedAccounts = [account];
    config.proxy.preferred_account_id = account.id;
    selectCloudAccountAdapter({ mode: 'standalone-core', client: new CoreRpcClient(socketPath) });
    proxyModelAvailabilityStore.mark('account-1', 'gemini-3-pro', 'model_forbidden');
    await rendererCloud.setAccountProxy({ accountId: 'account-1', proxyUrl });
    expect((await rendererCloud.listCloudAccounts())[0]?.proxy_configured).toBe(true);
    await rendererCloud.setAccountProxy({ accountId: 'account-1', proxyUrl: null });
    expect((await rendererCloud.listCloudAccounts())[0]?.proxy_configured).toBe(false);
    await rendererCloud.deleteCloudAccount({ accountId: 'account-1' });
    expect(proxyModelAvailabilityStore.isCapabilityBlocked('account-1', 'gemini-3-pro')).toBe(
      false,
    );
    expect(await rendererCloud.listCloudAccounts()).toEqual([]);
    expect(setProxy.mock.calls).toEqual([
      ['account-1', proxyUrl],
      ['account-1', null],
    ]);
    expect(removeAccount).toHaveBeenCalledOnce();
    expect(config.proxy.preferred_account_id).toBe('');
    expect(cleanup.mock.calls).toEqual([
      [account.id, expect.any(Function)],
      [account.id, expect.any(Function)],
    ]);
    await isolatedConfig.drain();
  }, 15_000);
});
