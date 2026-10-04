import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { call } from '@orpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreRpcClient } from '@/core/rpc/client';
import { ManagementServer } from '@/core/management/server';
import { createCoreRpcOperations } from '@/core/rpc/router';
import { createLocalAccountOwner } from '@/modules/account/services/local-account-owner.service';
import * as state from '@/modules/account/services/local-account-state.service';
import * as identity from '@/modules/account/services/local-account-identity.service';
import { getCurrentAccountInfo } from '@/modules/account/services/current-account.service';
import { selectLocalAccountAdapter } from '@/modules/account/ipc/local-account-adapter';
import { accountRouter, databaseRouter } from '@/modules/account/ipc/router';
import { LocalAccountInputSchema } from '@/modules/account/services/local-account.schema';
import { ProtobufUtils } from '@/shared/serialization/protobuf';
import { readAccountBackupFile } from '@/modules/account/persistence/account-backup-file';
const writeAccount = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/shared/security/security', async () => {
  const { encryptWithKey, decryptParsedPayloadWithKey, parseEncryptedPayload } =
    await import('@/shared/security/crypto');
  const key = Buffer.alloc(32, 7);
  return {
    initializeMasterKey: vi.fn(async () => ({ state: 'secure' })),
    encrypt: async (text: string) => encryptWithKey(key, text),
    decrypt: async (text: string) => {
      const payload = parseEncryptedPayload(text);
      if (!payload) {
        throw new Error('Invalid fixture ciphertext');
      }
      return decryptParsedPayloadWithKey(key, payload);
    },
  };
});
vi.mock('@/modules/antigravity-runtime/launchContext', () => ({
  prepareLaunchContext: vi.fn(async () => ({ pathOptions: {} })),
}));
vi.mock('@/modules/antigravity-runtime/credentials/clientAccountWrite', () => ({
  prepareClientAccountWrite: vi.fn(async () => ({ storage: 'sqlite', write: writeAccount })),
}));

const fixture = vi.hoisted(() => ({
  directory: '',
  profile: { machineId: 'machine', macMachineId: 'mac', devDeviceId: 'device', sqmId: 'sqm' },
  restoreGate: undefined as Promise<void> | undefined,
  releaseRestore: undefined as (() => void) | undefined,
  restoreStarted: vi.fn(),
}));
vi.mock('@/shared/platform/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/platform/paths')>()),
  getAgentDir: () => fixture.directory,
  getAccountsFilePath: () => path.join(fixture.directory, 'accounts.json'),
  getBackupsDir: () => path.join(fixture.directory, 'backups'),
  refreshAntigravityProcessCache: async () => {},
}));
vi.mock('@/modules/account/persistence/antigravity-state-database', () => ({
  getCurrentAccountInfo: vi.fn(() => ({
    email: 'fixture@example.com',
    name: 'Fixture',
    isAuthenticated: true,
  })),
  backupAccount: vi.fn((account) => ({
    version: '1.0',
    account,
    data: {
      'antigravityUnifiedStateSync.oauthToken': ProtobufUtils.createUnifiedOAuthToken(
        'fixture-access',
        'fixture-refresh',
        1700000000,
      ),
    },
  })),
  restoreAccount: vi.fn(),
  extractCredentialStoreTokenFromBackup: vi.fn(),
}));
vi.mock('@/modules/account/services/current-account.service', () => ({
  getCurrentAccountInfo: vi.fn(async () => ({
    email: 'fixture@example.com',
    name: 'Fixture',
    isAuthenticated: true,
  })),
}));
vi.mock('@/modules/identity-profile/ipc/handler', () => ({
  applyDeviceProfile: vi.fn(),
  ensureIdentityProfileStorage: vi.fn(),
  ensureGlobalOriginalFromCurrentStorage: vi.fn(),
  generateDeviceProfile: () => ({ ...fixture.profile }),
  readCurrentDeviceProfile: () => ({ ...fixture.profile }),
  loadGlobalOriginalProfile: () => ({ ...fixture.profile }),
  saveGlobalOriginalProfile: vi.fn(),
  isIdentityProfileApplyEnabled: () => true,
  getStorageDirectoryPath: () => fixture.directory,
}));
vi.mock('@/modules/antigravity-runtime/switch/switchFlow', () => ({
  executeSwitchFlow: async (input: {
    performSwitch(): Promise<void>;
    afterSwitchSuccess(): Promise<void>;
  }) => {
    fixture.restoreStarted();
    await fixture.restoreGate;
    await input.performSwitch();
    await input.afterSwitchSuccess();
  },
}));
vi.mock('electron', () => ({
  shell: { openPath: vi.fn() },
  app: { getPath: () => fixture.directory },
}));

let server: ManagementServer | undefined;
let owner: ReturnType<typeof createLocalAccountOwner>;
beforeEach(async () => {
  vi.clearAllMocks();
  writeAccount.mockReset().mockResolvedValue(undefined);
  fixture.restoreGate = undefined;
  fixture.releaseRestore = undefined;
  fixture.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-local-owner-'));
  owner = createLocalAccountOwner({ ...state, ...identity, getCurrentAccountInfo });
  selectLocalAccountAdapter({ mode: 'desktop-embedded' });
});
afterEach(async () => {
  fixture.releaseRestore?.();
  selectLocalAccountAdapter({ mode: 'desktop-embedded' });
  await server?.close();
  server = undefined;
  await owner.drain();
  await fs.rm(fixture.directory, { recursive: true, force: true });
});
async function remote() {
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\${path.basename(fixture.directory)}`
      : path.join(fixture.directory, 'core.sock');
  server = new ManagementServer({
    endpoint,
    getStatus: () => ({
      state: 'running',
      pid: process.pid,
      gateway: { running: false, port: null },
    }),
    shutdown: async () => {},
    onShutdownError: vi.fn(),
    rpc: {
      ...createCoreRpcOperations({ startGateway: vi.fn(), stopGateway: vi.fn() }),
      localAccount: owner,
    },
  });
  await server.start();
  const client = new CoreRpcClient(endpoint);
  selectLocalAccountAdapter({ mode: 'standalone-core', client });
  return client;
}

describe('selected local account owner', () => {
  it('preserves snapshot parity while keeping credential files and paths inside the owner', async () => {
    const saved = await owner.addAccountSnapshot();
    const embedded = await owner.listAccounts();
    expect(await call(accountRouter.listAccounts, undefined)).toEqual(embedded);
    const client = await remote();
    expect(await client.localAccounts.listAccounts()).toEqual(embedded);
    expect(await call(accountRouter.listAccounts, undefined)).toEqual(embedded);
    expect(await call(databaseRouter.getCurrentAccountInfo, undefined)).toEqual({
      email: 'fixture@example.com',
      name: 'Fixture',
      isAuthenticated: true,
    });
    expect(JSON.stringify(embedded)).not.toMatch(/backup_file|backups|fixture-private-grant/);
    const backup = await readAccountBackupFile(
      path.join(fixture.directory, 'backups', `${saved.id}.json`),
    );
    expect(backup.data).toEqual({
      'antigravityUnifiedStateSync.oauthToken': ProtobufUtils.createUnifiedOAuthToken(
        'fixture-access',
        'fixture-refresh',
        1700000000,
      ),
    });
    // Same-email snapshots update the existing entry and backup, preserving the local collision policy.
    expect((await client.localAccounts.addAccountSnapshot()).id).toBe(saved.id);
    expect(await client.localAccounts.listAccounts()).toHaveLength(1);
  });

  it('restores the existing owner backup once and preserves identity metadata', async () => {
    const saved = await owner.addAccountSnapshot();
    const client = await remote();
    const profile = await client.localAccounts.bindIdentityProfile(saved.id, 'capture');
    expect(profile).toEqual(fixture.profile);
    await call(accountRouter.switchAccount, { accountId: saved.id, appTarget: 'classic' });
    expect(writeAccount).toHaveBeenCalledExactlyOnceWith();
    const view = (await client.localAccounts.listAccounts())[0];
    expect(view.deviceProfile).toEqual(fixture.profile);
    expect(view.deviceHistory).toHaveLength(1);
    expect(await client.localAccounts.getIdentityProfiles(saved.id)).toEqual({
      currentStorage: fixture.profile,
      boundProfile: fixture.profile,
      baseline: fixture.profile,
      history: view.deviceHistory,
    });
    await client.localAccounts.restoreBaselineProfile(saved.id);
    expect((await client.localAccounts.getIdentityProfiles(saved.id)).history[0].isCurrent).toBe(
      false,
    );
  });

  it('sanitizes restore errors and rejects malformed transport before persistence', async () => {
    const saved = await owner.addAccountSnapshot();
    const client = await remote();
    writeAccount.mockImplementation(async () => {
      throw new Error('fixture-private-grant /private/backup.db');
    });
    await expect(client.localAccounts.switchAccount(saved.id)).rejects.toMatchObject({
      message: 'Unable to complete this account action right now. Please try again.',
      data: { accountCode: 'restore-failed' },
    });
    expect(
      LocalAccountInputSchema.safeParse({
        accountId: saved.id,
        refresh_token: 'fixture-private-grant',
      }).success,
    ).toBe(false);
    await expect(
      client.localAccounts.bindIdentityProfileWithPayload(saved.id, {
        ...fixture.profile,
        machineId: 'x'.repeat(257),
      }),
    ).rejects.toThrow();
    expect((await owner.listAccounts())[0].deviceHistory).toHaveLength(0);
  });

  it('drains an admitted restore, rejects subsequent work, and serializes conflicting writes', async () => {
    const saved = await owner.addAccountSnapshot();
    const client = await remote();
    fixture.restoreGate = new Promise<void>((resolve) => {
      fixture.releaseRestore = resolve;
    });
    const restore = client.localAccounts.switchAccount(saved.id);
    // Wait until the real request has entered the owner rather than closing admission before dispatch.
    await vi.waitFor(() => expect(fixture.restoreStarted).toHaveBeenCalledOnce());
    const deletion = owner.deleteAccount(saved.id);
    owner.closeAdmission();
    const drained = vi.fn();
    const drain = owner.drain().then(drained);
    await expect(owner.addAccountSnapshot()).rejects.toMatchObject({ code: 'unavailable' });
    expect(drained).not.toHaveBeenCalled();
    fixture.releaseRestore?.();
    await restore;
    await deletion;
    await drain;
    expect(drained).toHaveBeenCalledOnce();
    expect(writeAccount).toHaveBeenCalledOnce();
    await expect(client.localAccounts.listAccounts()).rejects.toMatchObject({
      data: { accountCode: 'unavailable' },
    });
  });

  it('fails remote reads without executing local persistence after disconnect', async () => {
    const saved = await owner.addAccountSnapshot();
    await remote();
    await server?.close();
    server = undefined;
    const reads = vi.spyOn(state, 'listAccountsData');
    await expect(call(accountRouter.listAccounts, undefined)).rejects.toMatchObject({
      data: { accountCode: 'unavailable' },
    });
    expect(reads).not.toHaveBeenCalled();
    expect((await owner.listAccounts())[0].id).toBe(saved.id);
    reads.mockRestore();
  });
});
