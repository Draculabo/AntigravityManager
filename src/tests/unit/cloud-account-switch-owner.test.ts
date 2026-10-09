import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRouterClient } from '@orpc/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagementServer } from '@/core/management/server';
import { CoreRpcClient } from '@/core/rpc/client';
import { createCoreRpcOperations } from '@/core/rpc/router';
import { cloudRouter } from '@/modules/cloud-account/ipc/router';
import { selectCloudAccountAdapter } from '@/modules/cloud-account/ipc/cloud-account-adapter';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { CloudAccountSettingsStore } from '@/modules/cloud-account/persistence/cloud-account-settings-store';
import {
  CloudAccountRefreshBlockedError,
  CloudAccountRefreshService,
} from '@/modules/cloud-account/services/CloudAccountRefreshService';
const credentialWrite = vi.hoisted(() => vi.fn(async () => undefined));
import { switchCloudAccountCore } from '@/modules/cloud-account/services/cloud-account-switch.service';
import { accountOwnerEvents } from '@/modules/cloud-account/services/account-owner-events.service';
import { getSwitchGuardSnapshot } from '@/modules/antigravity-runtime/switch/switchGuard';
import { logger } from '@/shared/logging/logger';
import * as runtimeStop from '@/modules/antigravity-runtime/stop';
import { processError } from '@/modules/antigravity-runtime/processErrors';

const ownerState = vi.hoisted(() => ({
  activeId: null as string | null,
  activeAgyId: null as string | null,
  lastUsedId: null as string | null,
}));

const account = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'google' as const,
  email: 'owner@example.com',
  name: 'Owner',
  avatar_url: null,
  token: {
    access_token: 'private-access-token',
    refresh_token: '',
    expires_in: 3600,
    expiry_timestamp: 1_700_000_000,
    token_type: 'Bearer',
  },
  device_profile: {
    machineId: 'machine',
    macMachineId: 'mac',
    devDeviceId: 'device',
    sqmId: '{SQM}',
  },
  created_at: 1,
  last_used: 1,
};

vi.mock('@/modules/cloud-account/ipc/handler', () => ({}));
vi.mock('@/modules/cloud-account/persistence/cloudHandler', () => ({
  CloudAccountRepo: {
    getAccount: vi.fn(async () => account),
    updateToken: vi.fn(async () => {}),
    updateLastUsed: vi.fn((id: string) => {
      ownerState.lastUsedId = id;
    }),
    setActive: vi.fn((id: string) => {
      ownerState.activeId = id;
    }),
  },
}));
vi.mock('@/modules/cloud-account/persistence/cloud-account-settings-store', () => ({
  CloudAccountSettingsStore: {
    setActiveForTarget: vi.fn((_target: string | undefined, id: string) => {
      ownerState.activeAgyId = id;
    }),
  },
}));
vi.mock('@/modules/antigravity-runtime/credentials/clientAccountWrite', () => ({
  prepareClientAccountWrite: vi.fn(async () => ({
    storage: 'credential-store',
    write: credentialWrite,
  })),
  resolveClientAccountStorage: vi.fn(async () => 'credential-store'),
}));
vi.mock('@/modules/cloud-account/persistence/cloud-account-device-binding-store', () => ({
  CloudAccountDeviceBindingStore: { setDeviceBinding: vi.fn() },
}));
vi.mock('@/modules/cloud-account/services/CloudAccountRefreshService', () => {
  class CloudAccountRefreshBlockedError extends Error {}
  return {
    CloudAccountRefreshBlockedError,
    CloudAccountRefreshService: { refreshAccessToken: vi.fn() },
    createCloudAccountRefreshRequest: vi.fn(() => ({ accountId: account.id })),
    isRetryableInvalidGrantRefreshError: vi.fn(() => false),
  };
});
vi.mock('@/modules/cloud-account/services/cloud-account-refresh-state.service', () => ({
  clearAccountStatus: vi.fn(async () => {}),
  markAccountStatusFromError: vi.fn(async () => {}),
  mergeRefreshedToken: vi.fn(),
}));
vi.mock('@/modules/cloud-account/services/cloud-account-list.service', () => ({
  cloudAccountListService: {
    listViews: vi.fn(async () => [
      {
        id: account.id,
        provider: account.provider,
        email: account.email,
        created_at: account.created_at,
        last_used: account.last_used,
        is_active: ownerState.activeId === account.id,
        is_active_agy: ownerState.activeAgyId === account.id,
        proxy_configured: false,
      },
    ]),
  },
}));
vi.mock('@/modules/identity-profile/ipc/handler', () => ({
  getDeviceHardeningSnapshot: vi.fn(() => ({
    consecutiveApplyFailures: 0,
    safeModeActive: false,
    safeModeUntil: null,
    lastFailureReason: null,
    lastFailureStage: null,
    lastFailureAt: null,
  })),
  ensureGlobalOriginalFromCurrentStorage: vi.fn(),
  generateDeviceProfile: vi.fn(),
  isIdentityProfileApplyEnabled: vi.fn(() => false),
  saveGlobalOriginalProfile: vi.fn(),
  applyDeviceProfile: vi.fn(),
  syncTelemetryServiceMachineIdValue: vi.fn(),
}));
vi.mock('@/modules/antigravity-runtime/ipc/handler', () => ({
  closeAntigravity: vi.fn(),
  isProcessRunning: vi.fn(),
  startAntigravity: vi.fn(),
  _waitForProcessExit: vi.fn(),
}));
vi.mock('@/shared/platform/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/platform/paths')>()),
  refreshAntigravityProcessCache: vi.fn(async () => {}),
  getAntigravityDbPaths: vi.fn(() => []),
}));
vi.mock('@/shared/logging/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let server: ManagementServer | null = null;
let directory: string | null = null;

afterEach(async () => {
  selectCloudAccountAdapter({ mode: 'desktop-embedded' });
  await server?.close();
  server = null;
  if (directory) {
    await fs.rm(directory, { recursive: true, force: true });
    directory = null;
  }
  account.token.refresh_token = '';
  ownerState.activeId = null;
  ownerState.activeAgyId = null;
  ownerState.lastUsedId = null;
  vi.clearAllMocks();
});

async function startOwner(): Promise<CoreRpcClient> {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-switch-owner-'));
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\agm-switch-owner-${path.basename(directory)}`
      : path.join(directory, 'core.sock');
  server = new ManagementServer({
    endpoint,
    getStatus: () => ({ state: 'running', pid: 123, gateway: { running: false, port: null } }),
    shutdown: async () => {},
    onShutdownError: vi.fn(),
    rpc: createCoreRpcOperations({ startGateway: vi.fn(), stopGateway: vi.fn() }),
  });
  await server.start();
  return new CoreRpcClient(endpoint);
}

describe('core-owned cloud account switching', () => {
  it.each(['desktop-embedded', 'standalone-core'] as const)(
    'reports a refused client close without writing credentials or selecting the account (%s)',
    async (mode) => {
      if (mode === 'standalone-core') {
        const client = await startOwner();
        selectCloudAccountAdapter({ mode, client });
      }
      const stop = vi
        .spyOn(runtimeStop, 'stopFromContext')
        .mockRejectedValueOnce(processError('exit-unconfirmed'));
      try {
        await expect(
          createRouterClient(cloudRouter).switchCloudAccount({ accountId: account.id }),
        ).rejects.toMatchObject({
          message: 'Cloud account switch failed',
          data: { switchCode: 'process-close-failed' },
        });
        expect(credentialWrite).not.toHaveBeenCalled();
        expect(CloudAccountRepo.setActive).not.toHaveBeenCalled();
        expect(CloudAccountRepo.updateLastUsed).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledExactlyOnceWith('Failed to switch cloud account', {
          kind: 'process-close-failed',
          stage: 'switch-execution',
          target: 'classic',
          storage: 'credential-store',
          reason: 'process_close_failed',
          errorCode: 'ANTIGRAVITY_PROCESS_FAILED',
        });
      } finally {
        stop.mockRestore();
      }
    },
  );
  it('does not turn a presentation failure into an account switch failure', async () => {
    const cursor = accountOwnerEvents.read(undefined, 0);
    await expect(
      switchCloudAccountCore(account.id, 'agy', {
        presentationReason: 'auto',
        onSuccess: () => {
          throw new Error('Tray unavailable');
        },
      }),
    ).resolves.toBeUndefined();
    expect(CloudAccountRepo.setActive).toHaveBeenCalledExactlyOnceWith(account.id);
    expect(accountOwnerEvents.read(cursor.epoch, cursor.latest).events).toEqual([
      {
        sequence: cursor.latest + 1,
        event: { kind: 'account-switched', accountId: account.id, target: 'agy', reason: 'auto' },
      },
    ]);
  });
  it('persists an Agy switch in the owner and reflects it through subsequent views', async () => {
    const client = await startOwner();
    selectCloudAccountAdapter({ mode: 'standalone-core', client });
    const previousStatus = await createRouterClient(cloudRouter).getSwitchStatus();
    const cursor = await client.readAccountOwnerEvents(undefined, 0);

    await expect(client.switchCloudAccount(account.id, 'agy')).resolves.toBeUndefined();
    const status = await createRouterClient(cloudRouter).getSwitchStatus();
    expect(status.metrics.cloud.switchSuccess).toBe(previousStatus.metrics.cloud.switchSuccess + 1);
    expect(status.provenance).toBe('account-owner-process');
    expect(status.guard).toEqual({ activeOwner: null });
    expect(CloudAccountRepo.updateLastUsed).toHaveBeenCalledExactlyOnceWith(account.id);
    expect(CloudAccountRepo.setActive).toHaveBeenCalledExactlyOnceWith(account.id);
    expect(CloudAccountSettingsStore.setActiveForTarget).toHaveBeenCalledExactlyOnceWith(
      'agy',
      account.id,
    );
    expect(credentialWrite).toHaveBeenCalledExactlyOnceWith();
    expect(await client.accountViews()).toMatchObject([
      { id: account.id, is_active: true, is_active_agy: true },
    ]);
    const events = await client.readAccountOwnerEvents(cursor.epoch, cursor.latest);
    expect(events.events).toEqual([
      {
        sequence: cursor.latest + 1,
        event: { kind: 'account-switched', accountId: account.id, target: 'agy', reason: 'manual' },
      },
    ]);
    expect(JSON.stringify(events)).not.toMatch(
      /access_token|refresh_token|proxy_url|private-provider/,
    );
  });

  it('maps durable OAuth blocking to a value-free renderer reauth category', async () => {
    account.token.refresh_token = 'private-refresh-token';
    vi.mocked(CloudAccountRefreshService.refreshAccessToken).mockRejectedValueOnce(
      new CloudAccountRefreshBlockedError('private-provider-detail'),
    );
    const client = await startOwner();
    selectCloudAccountAdapter({ mode: 'standalone-core', client });

    try {
      await createRouterClient(cloudRouter).switchCloudAccount({ accountId: account.id });
      expect.fail('Blocked account should reject');
    } catch (error) {
      expect(error).toMatchObject({ data: { switchCode: 'reauth-required' } });
      expect(JSON.stringify(error)).not.toMatch(/private-provider-detail|private-refresh-token/);
    }
    expect(CloudAccountRepo.setActive).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledExactlyOnceWith('Failed to switch cloud account', {
      kind: 'reauth-required',
      stage: 'token-refresh',
      target: 'classic',
      storage: null,
      reason: 'unknown',
      errorCode: 'unknown',
    });
  });
  it('records a safe native write error code without changing the public error contract', async () => {
    credentialWrite.mockRejectedValueOnce(
      Object.assign(
        new Error('private-provider access_token=fixture-access /Users/alice/private'),
        { code: 'EACCES' },
      ),
    );
    const client = await startOwner();
    selectCloudAccountAdapter({ mode: 'standalone-core', client });
    await expect(
      createRouterClient(cloudRouter).switchCloudAccount({
        accountId: account.id,
        appTarget: 'agy',
      }),
    ).rejects.toMatchObject({
      message: 'Cloud account switch failed',
      data: { switchCode: 'target-write-failed' },
    });
    expect(logger.error).toHaveBeenCalledExactlyOnceWith('Failed to switch cloud account', {
      kind: 'target-write-failed',
      stage: 'switch-execution',
      target: 'agy',
      storage: 'credential-store',
      reason: 'perform_switch_failed',
      errorCode: 'EACCES',
    });
    expect(CloudAccountRepo.setActive).not.toHaveBeenCalled();
  });
  it('reports a failed remote switch without exposing its raw diagnostic text', async () => {
    const client = await startOwner();
    selectCloudAccountAdapter({ mode: 'standalone-core', client });
    const before = await client.accountSwitchStatus();
    vi.mocked(credentialWrite).mockImplementationOnce(() => {
      throw new Error(
        'private-provider C:\\secret\\token.sqlite http://user:password@host process --credential',
      );
    });
    await expect(client.switchCloudAccount(account.id, 'agy')).rejects.toThrow();
    const status = await createRouterClient(cloudRouter).getSwitchStatus();
    expect(status.metrics.cloud.switchFailure).toBe(before.metrics.cloud.switchFailure + 1);
    expect(status.metrics.cloud.lastFailure).toEqual({
      reason: 'perform_switch_failed',
      message: 'Account switch failed.',
      occurredAt: expect.any(Number),
    });
    expect(JSON.stringify(status)).not.toMatch(
      /private-provider|token.sqlite|password|credential|private-access/,
    );
  });
  it('reads actual owner guard state while a remote switch is in flight', async () => {
    let release!: (value: typeof account) => void;
    vi.mocked(CloudAccountRepo.getAccount).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const client = await startOwner();
    const switching = client.switchCloudAccount(account.id, 'agy');
    await vi.waitFor(() =>
      expect(getSwitchGuardSnapshot().activeOwner).toBe('cloud-account-switch'),
    );
    expect((await client.accountSwitchStatus()).guard).toEqual({
      activeOwner: 'cloud-account-switch',
    });
    release(account);
    await switching;
  });
});
