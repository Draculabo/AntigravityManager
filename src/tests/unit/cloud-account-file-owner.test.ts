import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dialog } from 'electron';
import { createRouterClient } from '@orpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagementServer } from '@/core/management/server';
import { CoreRpcClient } from '@/core/rpc/client';
import { createCoreRpcOperations } from '@/core/rpc/router';
import { cloudRouter } from '@/modules/cloud-account/ipc/router';
import {
  getCloudAccountAdapter,
  selectCloudAccountAdapter,
} from '@/modules/cloud-account/ipc/cloud-account-adapter';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { CloudAccountRefreshService } from '@/modules/cloud-account/services/CloudAccountRefreshService';
import { localAccountPostImportService } from '@/modules/cloud-account/local-import/local-account-post-import.service';
import { CLOUD_ACCOUNT_IMPORT_MAX_BYTES } from '@/modules/cloud-account/services/cloud-account-file.schema';
import type { CloudAccount } from '@/modules/cloud-account/types';

vi.mock('electron', () => ({ dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() } }));
vi.mock('@/modules/cloud-account/ipc/handler', () => ({}));
vi.mock('@/modules/cloud-account/services/cloud-account-switch.service', () => ({
  switchCloudAccountCore: vi.fn(),
}));
vi.mock('@/modules/cloud-account/persistence/cloudHandler', () => ({
  CloudAccountRepo: { getAccounts: vi.fn(), addAccount: vi.fn() },
}));
vi.mock('@/modules/cloud-account/services/CloudAccountRefreshService', () => ({
  CloudAccountRefreshService: { clearFailureState: vi.fn() },
}));
vi.mock('@/modules/cloud-account/local-import/local-account-post-import.service', () => ({
  localAccountPostImportService: { schedule: vi.fn(), drain: vi.fn() },
}));

const account: CloudAccount = {
  id: 'account-1',
  provider: 'google',
  email: 'test@example.com',
  token: {
    access_token: 'fixture-access-secret',
    refresh_token: 'fixture-refresh-secret',
    expires_in: 3600,
    expiry_timestamp: 1,
    token_type: 'Bearer',
  },
  created_at: 1,
  last_used: 2,
  status: 'active',
  device_profile: {
    machineId: 'machine',
    macMachineId: 'mac',
    devDeviceId: 'device',
    sqmId: '{SQM}',
  },
  proxy_url: 'http://user:fixture-proxy-secret@localhost:8080',
};
let directory: string;
let server: ManagementServer | null = null;
let accounts: CloudAccount[];
const renderer = createRouterClient(cloudRouter);

beforeEach(async () => {
  vi.resetAllMocks();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-file-owner-'));
  accounts = [structuredClone(account)];
  vi.mocked(CloudAccountRepo.getAccounts).mockImplementation(async () => accounts);
  vi.mocked(CloudAccountRepo.addAccount).mockImplementation(async (value) => {
    accounts = [...accounts.filter((item) => item.id !== value.id), value];
  });
  selectCloudAccountAdapter({ mode: 'desktop-embedded' });
});
afterEach(async () => {
  selectCloudAccountAdapter({ mode: 'desktop-embedded' });
  await server?.close();
  server = null;
  await fs.rm(directory, { recursive: true, force: true });
});

async function startRemote() {
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\agm-file-${path.basename(directory)}`
      : path.join(directory, 'core.sock');
  const operations = createCoreRpcOperations({ startGateway: vi.fn(), stopGateway: vi.fn() });
  server = new ManagementServer({
    endpoint,
    getStatus: () => ({ state: 'running', pid: 123, gateway: { running: false, port: null } }),
    shutdown: async () => {},
    onShutdownError: vi.fn(),
    rpc: operations,
  });
  await server.start();
  const client = new CoreRpcClient(endpoint);
  selectCloudAccountAdapter({ mode: 'standalone-core', client });
  return { client, operations };
}
function chooseImport(filePath: string) {
  vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
    canceled: false,
    filePaths: [filePath],
  });
}
function chooseExport(filePath: string) {
  vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath });
}
async function importDocument(entries: unknown[], padding = 0) {
  const filePath = path.join(directory, 'import.json');
  const content = JSON.stringify({ version: '1.0', exportedAt: 1, accounts: entries });
  await fs.writeFile(filePath, content + ' '.repeat(padding));
  chooseImport(filePath);
  return filePath;
}
function exportedAccount(token = account.token) {
  return {
    provider: account.provider,
    email: account.email,
    token,
    device_profile: account.device_profile,
    proxy_url: account.proxy_url,
  };
}
async function fails(action: () => Promise<unknown>, code: string) {
  await expect(action()).rejects.toMatchObject({
    data: { fileCode: code },
    message: 'Cloud account file operation failed',
  });
}

describe.each(['desktop-embedded', 'standalone-core'] as const)(
  'cloud files in %s owner',
  (mode) => {
    beforeEach(async () => {
      if (mode === 'standalone-core') {
        await startRemote();
      }
    });

    it('exports secrets only to disk and supports stripped backups without renderer content or paths', async () => {
      const full = path.join(directory, 'full.json');
      chooseExport(full);
      expect(await renderer.exportCloudAccounts({ stripTokens: false })).toEqual({
        status: 'saved',
      });
      const document = JSON.parse(await fs.readFile(full, 'utf8'));
      expect(document.accounts[0]).toMatchObject({
        token: account.token,
        device_profile: account.device_profile,
        proxy_url: account.proxy_url,
      });
      const stripped = path.join(directory, 'stripped.json');
      chooseExport(stripped);
      expect(await renderer.exportCloudAccounts({ stripTokens: true })).toEqual({
        status: 'saved',
      });
      const strippedText = await fs.readFile(stripped, 'utf8');
      expect(strippedText).not.toMatch(/fixture-access-secret|fixture-refresh-secret|"token"/);
    });

    it.each(['merge', 'overwrite', 'skip-existing'] as const)(
      'preserves %s policy and owner post-import effects',
      async (strategy) => {
        await importDocument([
          { ...exportedAccount(), name: 'Renamed' },
          { ...exportedAccount(), email: 'new@example.com' },
        ]);
        const result = await renderer.importCloudAccounts({ strategy });
        expect(result).toEqual({
          status: 'imported',
          imported: 1,
          updated: strategy === 'skip-existing' ? 0 : 1,
          skipped: strategy === 'skip-existing' ? 1 : 0,
          failed: 0,
          errors: [],
        });
        expect(accounts.find((item) => item.id === account.id)?.name).toBe(
          strategy === 'skip-existing' ? undefined : 'Renamed',
        );
        expect(accounts.find((item) => item.email === 'new@example.com')).toMatchObject({
          token: account.token,
          device_profile: account.device_profile,
          proxy_url: account.proxy_url,
        });
        expect(localAccountPostImportService.schedule).toHaveBeenCalledExactlyOnceWith(
          accounts
            .filter((item) => strategy !== 'skip-existing' || item.id !== account.id)
            .map((item) => item.id),
        );
      },
    );

    it('preserves same-grant blocks and clears OAuth health only after grant replacement', async () => {
      accounts[0].health = {
        oauth: { refresh_blocked: true, reason: 'invalid_grant' },
        validation: {
          status: 'requires_action',
          reason: 'VALIDATION_REQUIRED',
          detected_at_ms: 1,
          next_probe_at_ms: 2,
        },
      };
      accounts[0].status = 'expired';
      accounts[0].status_reason =
        'Repeated OAuth invalid_grant responses require account reauthorization';
      const health = structuredClone(accounts[0].health);
      await importDocument([exportedAccount()]);
      await renderer.importCloudAccounts({ strategy: 'overwrite' });
      expect(accounts[0]).toMatchObject({ health, status: 'expired' });
      expect(CloudAccountRefreshService.clearFailureState).not.toHaveBeenCalled();
      await importDocument([
        exportedAccount({ ...account.token, refresh_token: 'replacement-grant' }),
      ]);
      await renderer.importCloudAccounts({ strategy: 'merge' });
      expect(accounts[0]).toMatchObject({
        health: { validation: health.validation },
        status: 'active',
      });
      expect(accounts[0].health?.oauth).toBeUndefined();
      expect(accounts[0].status_reason).toBeUndefined();
      expect(CloudAccountRefreshService.clearFailureState).toHaveBeenCalledExactlyOnceWith(
        account.id,
      );
    });

    it('accepts exactly 5 MiB, rejects larger files and never transports the document in RPC', async () => {
      const content = JSON.stringify({
        version: '1.0',
        exportedAt: 1,
        accounts: [exportedAccount()],
      });
      const filePath = await importDocument(
        [exportedAccount()],
        CLOUD_ACCOUNT_IMPORT_MAX_BYTES - Buffer.byteLength(content),
      );
      expect(await renderer.importCloudAccounts({ strategy: 'merge' })).toEqual({
        status: 'imported',
        imported: 0,
        updated: 1,
        skipped: 0,
        failed: 0,
        errors: [],
      });
      await fs.appendFile(filePath, ' ');
      chooseImport(filePath);
      await fails(() => renderer.importCloudAccounts({ strategy: 'merge' }), 'file-too-large');
    });

    it('sanitizes malformed input, file IO, repository and account failures', async () => {
      const filePath = path.join(directory, 'invalid.json');
      await fs.writeFile(filePath, '{private-provider-secret');
      chooseImport(filePath);
      await fails(() => renderer.importCloudAccounts({}), 'invalid-export');
      await importDocument([{ provider: 'invalid', email: account.email }]);
      await fails(() => renderer.importCloudAccounts({}), 'invalid-export');
      await importDocument([exportedAccount(), exportedAccount()]);
      await fails(() => renderer.importCloudAccounts({}), 'invalid-export');
      chooseImport(path.join(directory, 'private-path-missing.json'));
      await fails(() => renderer.importCloudAccounts({}), 'read-failed');
      chooseExport(directory);
      await fails(() => renderer.exportCloudAccounts({}), 'write-failed');
      await importDocument([exportedAccount()]);
      vi.mocked(CloudAccountRepo.getAccounts).mockRejectedValueOnce(
        new Error('SQLite private-path private-provider-secret'),
      );
      await fails(() => renderer.importCloudAccounts({}), 'import-failed');
      await importDocument([exportedAccount(), { provider: 'google', email: 'new@example.com' }]);
      vi.mocked(CloudAccountRepo.addAccount).mockRejectedValueOnce(
        new Error('SQLite private-provider-secret'),
      );
      expect(await renderer.importCloudAccounts({})).toEqual({
        status: 'imported',
        imported: 0,
        updated: 0,
        skipped: 0,
        failed: 2,
        errors: [
          { code: 'account-write-failed', email: account.email },
          { code: 'tokens-missing', email: 'new@example.com' },
        ],
      });
    });

    it('preserves an existing backup and cleans temporary files when atomic replacement fails', async () => {
      const filePath = path.join(directory, 'backup.json');
      await fs.writeFile(filePath, 'previous-backup');
      chooseExport(filePath);
      const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('private-path-secret'));
      try {
        await fails(() => renderer.exportCloudAccounts({}), 'write-failed');
        expect(await fs.readFile(filePath, 'utf8')).toBe('previous-backup');
        expect((await fs.readdir(directory)).filter((file) => file.endsWith('.tmp'))).toEqual([]);
      } finally {
        rename.mockRestore();
      }
    });

    it('handles cancelled dialogs without repository operations and rejects renderer content/path injection', async () => {
      vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: true, filePaths: [] });
      vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: true, filePath: '' });
      expect(await renderer.importCloudAccounts({})).toEqual({ status: 'cancelled' });
      expect(await renderer.exportCloudAccounts({})).toEqual({ status: 'cancelled' });
      expect(CloudAccountRepo.getAccounts).not.toHaveBeenCalled();
      // Runtime callers are untrusted despite the statically typed client.
      await expect(
        renderer.importCloudAccounts({ jsonContent: 'secret', strategy: 'merge' } as never),
      ).rejects.toThrow();
      await expect(
        renderer.exportCloudAccounts({ filePath: '/private-path', stripTokens: true } as never),
      ).rejects.toThrow();
    });
  },
);

it('drains an admitted remote import after client dispatch and rejects new imports', async () => {
  const { operations } = await startRemote();
  let finishWrite: () => void = () => {};
  let admitted: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  vi.mocked(CloudAccountRepo.addAccount).mockImplementationOnce(() => {
    admitted();
    return new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
  });
  const filePath = await importDocument([exportedAccount()]);
  const importing = renderer.importCloudAccounts({});
  await entered;
  operations.closeAccountMutationAdmission();
  let drained = false;
  const draining = operations.drainAccountMutations().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  await expect(getCloudAccountAdapter().importFile(filePath, 'merge')).rejects.toMatchObject({
    data: { fileCode: 'import-failed' },
  });
  finishWrite();
  expect(await importing).toMatchObject({ status: 'imported', updated: 1 });
  await draining;
  expect(drained).toBe(true);
  expect(localAccountPostImportService.drain).toHaveBeenCalledOnce();
});

it('keeps file content and paths out of renderer/preload source contracts', async () => {
  for (const file of [
    'src/modules/cloud-account/actions/cloud.ts',
    'src/modules/cloud-account/components/CloudAccountList.tsx',
    'src/modules/cloud-account/components/CloudAccountToolbar.tsx',
    'src/preload.ts',
  ]) {
    const source = await fs.readFile(file, 'utf8');
    expect(source).not.toMatch(
      /FileReader|new Blob|createObjectURL|jsonContent|importFileContent|filePath/,
    );
  }
});

it('bounds per-account diagnostics while preserving the total failure count', async () => {
  await startRemote();
  await importDocument(
    Array.from({ length: 120 }, (_, index) => ({
      provider: 'google',
      email: `missing-${index}@example.com`,
    })),
  );
  const result = await renderer.importCloudAccounts({});
  expect(result).toMatchObject({
    status: 'imported',
    failed: 120,
    imported: 0,
    updated: 0,
    skipped: 0,
  });
  if (result.status === 'imported') {
    expect(result.errors).toHaveLength(100);
    expect(result.errors.every((error) => error.code === 'tokens-missing')).toBe(true);
  }
});
