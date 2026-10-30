import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { ManagementServer } from '@/core/management/server';
import { CoreRpcClient } from '@/core/rpc/client';
import { createCoreRpcOperations } from '@/core/rpc/router';
import { selectCloudAccountAdapter } from '@/modules/cloud-account/ipc/cloud-account-adapter';

const credentialWrite = vi.hoisted(() => vi.fn(async () => undefined));

import { logger } from '@/shared/logging/logger';
import * as runtimeLaunch from '@/modules/antigravity-runtime/launchContext';
import {
  CloudSwitchDiagnosticSchema,
  type CloudSwitchDiagnostic,
} from '@/modules/cloud-account/services/operation-diagnostic.schema';

function expectTerminalDiagnostic(expected: Omit<CloudSwitchDiagnostic, 'diagnosticId'>) {
  const records = vi
    .mocked(logger.info)
    .mock.calls.filter((call) => call[0] === 'Operation diagnostic v1');
  expect(records).toHaveLength(1);
  const actual = CloudSwitchDiagnosticSchema.parse(records[0][1]);
  expect(records).toEqual([
    ['Operation diagnostic v1', { ...expected, diagnosticId: actual.diagnosticId }],
  ]);
}

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

vi.mock('@/modules/antigravity-runtime/terms/classicTermsSwitch', () => ({
  prepareClassicTermsSwitch: vi.fn(async () => ({
    captureForHotSwitch: async () => {},
    confirmHotSwitch: async () => true,
    apply: async () => {},
    rollback: async () => {},
  })),
}));
beforeEach(() => {
  const profile = path.join(os.tmpdir(), 'agm-switch-owner-fixture');
  vi.spyOn(runtimeLaunch, 'prepareLaunchContext').mockResolvedValue({
    target: 'classic',
    executablePath: path.join(profile, 'Antigravity.exe'),
    args: [],
    defaultUserDataDir: profile,
    pathOptions: { userDataDir: profile },
    processes: [],
  });
});

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
  vi.restoreAllMocks();
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
export { account, credentialWrite, ownerState, expectTerminalDiagnostic, startOwner };
