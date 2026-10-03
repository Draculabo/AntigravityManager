import os from 'os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  listAccountsData,
  addAccountSnapshot,
  switchAccount,
  deleteAccount,
} from '@/modules/account/ipc/handler';
import { prepareClientAccountWrite } from '@/modules/antigravity-runtime/credentials/clientAccountWrite';
const writeAccount = vi.hoisted(() => vi.fn(async () => undefined));
import { startFromContext as startAntigravity } from '@/modules/antigravity-runtime/launch';
import fs from 'fs';
import path from 'path';
import { applyDeviceProfile, generateDeviceProfile } from '@/modules/identity-profile/ipc/handler';
import { getSwitchGuardSnapshot } from '@/modules/antigravity-runtime/switch/switchGuard';
import { ProtobufUtils } from '@/shared/serialization/protobuf';
vi.mock('@/shared/security/security', async () => {
  const { encryptWithKey, decryptParsedPayloadWithKey, parseEncryptedPayload } =
    await import('@/shared/security/crypto');
  const key = Buffer.alloc(32, 7);
  return {
    encrypt: async (text: string) => encryptWithKey(key, text),
    decrypt: async (text: string) => {
      const payload = parseEncryptedPayload(text);
      if (!payload) {
        throw new Error('invalid fixture ciphertext');
      }
      return decryptParsedPayloadWithKey(key, payload);
    },
  };
});
import {
  mutateAccountIndex,
  readAccountIndex,
} from '@/modules/account/persistence/account-index-store';

// Mock dependencies
vi.mock('../../shared/platform/paths', async () => {
  const path = await import('path');
  const os = await import('os');
  const agentDir = path.join(os.tmpdir(), 'agm-runtime-account-' + process.pid);
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
  backupAccount: vi.fn((account) => ({
    version: '1.0',
    account,
    data: {
      'antigravityUnifiedStateSync.oauthToken': ProtobufUtils.createUnifiedOAuthToken(
        'access',
        'refresh',
        1700000000,
      ),
    },
  })),
  restoreAccount: vi.fn(),
  extractCredentialStoreTokenFromBackup: vi.fn(() => ({
    access_token: 'access',
    refresh_token: 'refresh',
    expiry_timestamp: 1700000000,
  })),
  getDatabaseConnection: vi.fn(),
}));

vi.mock('@/modules/antigravity-runtime/credentials/clientAccountWrite', () => ({
  prepareClientAccountWrite: vi.fn(async () => ({ storage: 'sqlite', write: writeAccount })),
}));

vi.mock('@/modules/antigravity-runtime/credentials/antigravityCredentialStore', () => ({
  writeAntigravityCredentialStoreToken: vi.fn(),
}));

vi.mock('@/modules/antigravity-runtime/launch', () => ({ startFromContext: vi.fn() }));
vi.mock('@/modules/antigravity-runtime/stop', () => ({ stopFromContext: vi.fn() }));

vi.mock('@/modules/identity-profile/ipc/handler', () => ({
  applyDeviceProfile: vi.fn(),
  ensureIdentityProfileStorage: vi.fn(),
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
  const testAgentDir = path.join(os.tmpdir(), 'agm-runtime-account-' + process.pid);

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
    expect(prepareClientAccountWrite).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'test@example.com' }),
      'ide',
      {
        userDataDir: '/fixture/data',
      },
    );
    expect(applyDeviceProfile).toHaveBeenCalledWith(expect.any(Object), 'ide', {
      userDataDir: '/fixture/data',
    });
  });

  it.each([undefined, 'classic', 'agy'] as const)(
    'prepares one credential destination for target %s',
    async (target) => {
      const account = await addAccountSnapshot();
      await switchAccount(account.id, target);
      expect(prepareClientAccountWrite).toHaveBeenCalledExactlyOnceWith(
        {
          email: 'test@example.com',
          name: 'Test User',
          token: {
            access_token: 'access',
            refresh_token: 'refresh',
            expiry_timestamp: 1700000000,
            is_gcp_tos: false,
          },
        },
        target,
        target === 'agy' ? undefined : { userDataDir: '/fixture/data' },
      );
      expect(writeAccount).toHaveBeenCalledOnce();
    },
  );

  it('rejects a corrupt backup before closing or writing the IDE', async () => {
    const account = await addAccountSnapshot();
    fs.writeFileSync(account.backup_file!, '{bad json');
    const { stopFromContext } = await import('@/modules/antigravity-runtime/stop');
    await expect(switchAccount(account.id, 'ide')).rejects.toThrow();
    expect(stopFromContext).not.toHaveBeenCalled();
    expect(prepareClientAccountWrite).not.toHaveBeenCalled();
    expect(writeAccount).not.toHaveBeenCalled();
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
      { userDataDir: '/fixture/data' },
    );
  });

  it('should delete account', async () => {
    const account = await addAccountSnapshot();
    await deleteAccount(account.id);

    const accounts = await listAccountsData();
    expect(accounts).toHaveLength(0);
  });

  it('should fail fast without rollback or forced restart when restore fails', async () => {
    const restoreMock = writeAccount;
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
      { userDataDir: '/fixture/data' },
    );
    expect(startAntigravity).not.toHaveBeenCalled();
  });

  it('rejects a concurrent switch immediately and never executes it later', async () => {
    const account = await addAccountSnapshot();

    const startMock = vi.mocked(startAntigravity);
    let releaseFirstStart!: () => void;
    const firstStartBlocker = new Promise<void>((resolve) => {
      releaseFirstStart = resolve;
    });
    let firstStartEntered!: () => void;
    const firstStartBarrier = new Promise<void>((resolve) => {
      firstStartEntered = resolve;
    });
    startMock.mockImplementationOnce(async () => {
      firstStartEntered();
      await firstStartBlocker;
    });

    const firstSwitch = switchAccount(account.id);
    await firstStartBarrier;
    try {
      await expect(switchAccount(account.id)).rejects.toMatchObject({
        messageKey: 'process-runtime.busy',
      });
      expect(getSwitchGuardSnapshot()).toEqual({ activeOwner: 'local-account-switch' });
    } finally {
      releaseFirstStart();
      await firstSwitch;
    }
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(writeAccount).toHaveBeenCalledTimes(1);
    expect(getSwitchGuardSnapshot()).toEqual({ activeOwner: null });
  });

  it('preserves concurrent account fields when a paused switch commits its owned fields', async () => {
    const account = await addAccountSnapshot();
    const accountFilePath = path.join(testAgentDir, 'accounts.json');
    const concurrentProfile = {
      machineId: 'concurrent-machine',
      macMachineId: 'concurrent-mac',
      devDeviceId: 'concurrent-dev',
      sqmId: '{CONCURRENT-SQM}',
    };
    const concurrentHistory = [
      {
        id: 'concurrent-history',
        createdAt: 1_788_739_200,
        label: 'concurrent',
        profile: concurrentProfile,
        isCurrent: true,
      },
    ];
    const futureLastUsed = '2099-01-01T00:00:00.000Z';

    let releaseStart!: () => void;
    let startEntered!: () => void;
    const startBarrier = new Promise<void>((resolve) => {
      startEntered = resolve;
    });
    const startBlocker = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    vi.mocked(startAntigravity).mockImplementationOnce(async () => {
      startEntered();
      await startBlocker;
    });

    const switchPromise = switchAccount(account.id);
    await startBarrier;

    await mutateAccountIndex(accountFilePath, (draft) => {
      const latest = draft[account.id];
      latest.name = 'Concurrent rename';
      latest.deviceProfile = concurrentProfile;
      latest.deviceHistory = concurrentHistory;
      latest.last_used = futureLastUsed;
    });
    releaseStart();
    await switchPromise;

    expect((await readAccountIndex(accountFilePath))[account.id]).toEqual({
      ...account,
      name: 'Concurrent rename',
      deviceProfile: concurrentProfile,
      deviceHistory: concurrentHistory,
      last_used: futureLastUsed,
    });
  });

  it('does not resurrect an account deleted while its switch is paused', async () => {
    const account = await addAccountSnapshot();
    const accountFilePath = path.join(testAgentDir, 'accounts.json');

    let releaseStart!: () => void;
    let startEntered!: () => void;
    const startBarrier = new Promise<void>((resolve) => {
      startEntered = resolve;
    });
    const startBlocker = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    vi.mocked(startAntigravity).mockImplementationOnce(async () => {
      startEntered();
      await startBlocker;
    });

    const switchPromise = switchAccount(account.id);
    await startBarrier;
    await mutateAccountIndex(accountFilePath, (draft) => {
      delete draft[account.id];
    });
    releaseStart();
    await switchPromise;

    expect(await readAccountIndex(accountFilePath)).toEqual({});
  });

  it('commits a generated switch profile when its starting identity snapshot is unchanged', async () => {
    const account = await addAccountSnapshot();
    const accountFilePath = path.join(testAgentDir, 'accounts.json');

    await switchAccount(account.id);

    const persisted = (await readAccountIndex(accountFilePath))[account.id];
    expect(persisted.deviceProfile).toEqual({
      machineId: 'auth0|user_test',
      macMachineId: 'mac-machine-id',
      devDeviceId: 'dev-device-id',
      sqmId: '{SQM-ID}',
    });
    expect(persisted.deviceHistory).toEqual([
      expect.objectContaining({
        label: 'auto_generated',
        profile: persisted.deviceProfile,
        isCurrent: true,
      }),
    ]);
  });
});

vi.mock('@/modules/antigravity-runtime/launchContext', async () => {
  const { switchContext } = await import('../support/runtime-switch-fixture');
  return {
    prepareLaunchContext: vi.fn(async (target: 'classic' | 'ide') => ({
      ...switchContext,
      target,
    })),
  };
});
