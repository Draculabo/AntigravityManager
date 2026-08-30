import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  listAccountsData,
  addAccountSnapshot,
  switchAccount,
  deleteAccount,
} from '@/modules/account/ipc/handler';
import { restoreAccount } from '@/modules/account/persistence/antigravity-state-database';
import { CredentialStoreInjectionAdapter } from '@/modules/cloud-account/persistence/credential-store-injection-adapter';
import { writeAntigravityCredentialStoreToken } from '@/modules/cloud-account/persistence/antigravityCredentialStore';
import { startAntigravity } from '@/modules/antigravity-runtime/ipc/handler';
import fs from 'fs';
import path from 'path';
import { applyDeviceProfile, generateDeviceProfile } from '@/modules/identity-profile/ipc/handler';
import { getSwitchGuardSnapshot } from '@/modules/antigravity-runtime/switch/switchGuard';

// Mock dependencies
vi.mock('../../shared/platform/paths', async () => {
  const path = await import('path');
  const agentDir = path.join(process.cwd(), 'temp_test_agent');
  return {
    getAgentDir: vi.fn(() => agentDir),
    getAccountsFilePath: vi.fn(() => path.join(agentDir, 'accounts.json')),
    getBackupsDir: vi.fn(() => path.join(agentDir, 'backups')),
    getAntigravityDbPath: vi.fn(() => path.join(agentDir, 'state.vscdb')),
    getAntigravityExecutablePath: vi.fn(() => 'mock_exec_path'),
    refreshAntigravityProcessCache: vi.fn(() => Promise.resolve()),
  };
});

vi.mock('@/modules/account/persistence/antigravity-state-database', () => ({
  getCurrentAccountInfo: vi.fn(() => ({
    email: 'test@example.com',
    name: 'Test User',
    isAuthenticated: true,
  })),
  backupAccount: vi.fn((account) => ({ version: '1.0', account, data: {} })),
  restoreAccount: vi.fn(),
  extractCredentialStoreTokenFromBackup: vi.fn(() => ({
    access_token: 'access',
    refresh_token: 'refresh',
    expiry_timestamp: 1700000000,
  })),
  getDatabaseConnection: vi.fn(),
}));

vi.mock('@/modules/cloud-account/persistence/credential-store-injection-adapter', () => ({
  CredentialStoreInjectionAdapter: {
    shouldInjectTokenIntoCredentialStore: vi.fn(() => false),
  },
}));

vi.mock('@/modules/cloud-account/persistence/antigravityCredentialStore', () => ({
  writeAntigravityCredentialStoreToken: vi.fn(),
}));

vi.mock('@/modules/antigravity-runtime/ipc/handler', () => ({
  closeAntigravity: vi.fn(),
  startAntigravity: vi.fn(),
  _waitForProcessExit: vi.fn(),
  isProcessRunning: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('@/modules/identity-profile/ipc/handler', () => ({
  applyDeviceProfile: vi.fn(),
  ensureGlobalOriginalFromCurrentStorage: vi.fn(),
  generateDeviceProfile: vi.fn(() => ({
    machineId: 'auth0|user_test',
    macMachineId: 'mac-machine-id',
    devDeviceId: 'dev-device-id',
    sqmId: '{SQM-ID}',
  })),
  loadGlobalOriginalProfile: vi.fn(() => null),
  isIdentityProfileApplyEnabled: vi.fn(() => true),
  readCurrentDeviceProfile: vi.fn(() => ({
    machineId: 'current-machine-id',
    macMachineId: 'current-mac-machine-id',
    devDeviceId: 'current-dev-device-id',
    sqmId: '{CURRENT-SQM-ID}',
  })),
  saveGlobalOriginalProfile: vi.fn(),
  syncTelemetryServiceMachineIdValue: vi.fn(),
}));

describe('Account Handler', () => {
  const testAgentDir = path.join(process.cwd(), 'temp_test_agent');

  beforeEach(() => {
    vi.clearAllMocks();
    if (fs.existsSync(testAgentDir)) {
      fs.rmSync(testAgentDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testAgentDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testAgentDir)) {
      fs.rmSync(testAgentDir, { recursive: true, force: true });
    }
  });

  it('should add account snapshot', async () => {
    const account = await addAccountSnapshot();
    expect(account.email).toBe('test@example.com');

    const accounts = await listAccountsData();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].email).toBe('test@example.com');
  });

  it('should switch account', async () => {
    const account = await addAccountSnapshot();
    await switchAccount(account.id);
    expect(generateDeviceProfile).toHaveBeenCalled();
    expect(applyDeviceProfile).toHaveBeenCalled();
  });

  it('should restore account to Antigravity IDE target', async () => {
    const account = await addAccountSnapshot();
    await switchAccount(account.id, 'ide');
    expect(restoreAccount).toHaveBeenCalledWith(expect.any(Object), 'ide');
    expect(applyDeviceProfile).toHaveBeenCalledWith(expect.any(Object), 'ide');
  });

  it('should use credential store for Classic when required', async () => {
    vi.mocked(
      CredentialStoreInjectionAdapter.shouldInjectTokenIntoCredentialStore,
    ).mockReturnValueOnce(true);

    const account = await addAccountSnapshot();
    await switchAccount(account.id);

    expect(restoreAccount).not.toHaveBeenCalled();
    expect(writeAntigravityCredentialStoreToken).toHaveBeenCalledWith({
      access_token: 'access',
      refresh_token: 'refresh',
      expiry_timestamp: 1700000000,
    });
  });

  it('should request generic Google OAuth sync for an explicit Agy switch', async () => {
    vi.mocked(
      CredentialStoreInjectionAdapter.shouldInjectTokenIntoCredentialStore,
    ).mockReturnValueOnce(true);

    const account = await addAccountSnapshot();
    await switchAccount(account.id, 'agy');

    expect(writeAntigravityCredentialStoreToken).toHaveBeenCalledWith(
      {
        access_token: 'access',
        refresh_token: 'refresh',
        expiry_timestamp: 1700000000,
      },
      {
        email: 'test@example.com',
        syncGoogleOAuthFiles: true,
      },
    );
  });

  it('should reuse existing device profile on switch', async () => {
    const account = await addAccountSnapshot();
    const accountFilePath = path.join(testAgentDir, 'accounts.json');
    const allAccounts = JSON.parse(fs.readFileSync(accountFilePath, 'utf-8')) as Record<
      string,
      any
    >;
    allAccounts[account.id].deviceProfile = {
      machineId: 'existing-machine',
      macMachineId: 'existing-mac',
      devDeviceId: 'existing-dev',
      sqmId: '{EXISTING-SQM}',
    };
    fs.writeFileSync(accountFilePath, JSON.stringify(allAccounts, null, 2), 'utf-8');

    await switchAccount(account.id);
    expect(applyDeviceProfile).toHaveBeenCalledWith(
      {
        machineId: 'existing-machine',
        macMachineId: 'existing-mac',
        devDeviceId: 'existing-dev',
        sqmId: '{EXISTING-SQM}',
      },
      undefined,
    );
  });

  it('should delete account', async () => {
    const account = await addAccountSnapshot();
    await deleteAccount(account.id);

    const accounts = await listAccountsData();
    expect(accounts).toHaveLength(0);
  });

  it('should fail fast without rollback or forced restart when restore fails', async () => {
    const restoreMock = vi.mocked(restoreAccount);
    restoreMock.mockImplementationOnce(() => {
      throw new Error('restore_failed');
    });

    const account = await addAccountSnapshot();
    await expect(switchAccount(account.id)).rejects.toThrow('restore_failed');

    expect(applyDeviceProfile).toHaveBeenCalledTimes(1);
    expect(applyDeviceProfile).toHaveBeenCalledWith(
      {
        machineId: 'auth0|user_test',
        macMachineId: 'mac-machine-id',
        devDeviceId: 'dev-device-id',
        sqmId: '{SQM-ID}',
      },
      undefined,
    );
    expect(startAntigravity).not.toHaveBeenCalled();
  });

  it('should queue switch requests instead of rejecting concurrent calls', async () => {
    const account = await addAccountSnapshot();

    const startMock = vi.mocked(startAntigravity);
    let releaseFirstStart!: () => void;
    const firstStartBlocker = new Promise<void>((resolve) => {
      releaseFirstStart = resolve;
    });
    startMock.mockImplementationOnce(async () => {
      await firstStartBlocker;
    });

    const firstSwitch = switchAccount(account.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const secondSwitch = switchAccount(account.id);

    const runningSnapshot = getSwitchGuardSnapshot();
    expect(runningSnapshot.activeOwner).toBe('local-account-switch');
    expect(runningSnapshot.pendingCount).toBeGreaterThanOrEqual(1);

    releaseFirstStart();

    await Promise.all([firstSwitch, secondSwitch]);

    const finalSnapshot = getSwitchGuardSnapshot();
    expect(finalSnapshot.activeOwner).toBeNull();
    expect(finalSnapshot.pendingCount).toBe(0);
  });
});
