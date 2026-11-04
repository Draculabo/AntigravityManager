// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  prepareWindowsIdeRecovery,
  restoreWindowsIdeCredentials,
} from '@/modules/antigravity-runtime/credentials/windowsIdeRecovery';
import {
  getIdeStandaloneTokenPath,
  writeIdeStandaloneToken,
} from '@/modules/antigravity-runtime/credentials/ideStandaloneToken';
import type { WindowsCredentialSnapshot } from '@/modules/antigravity-runtime/credentials/windowsCredentialStore';
import { runWithSwitchGuard } from '@/modules/antigravity-runtime/switch/switchGuard';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  restore: vi.fn(),
  observe: vi.fn(),
  initialize: vi.fn(),
}));
vi.mock('@/modules/antigravity-runtime/processObserver', () => ({
  observeProcesses: mocks.observe,
}));
vi.mock('@/modules/antigravity-runtime/credentials/windowsCredentialStore', async (original) => ({
  ...(await original<
    typeof import('@/modules/antigravity-runtime/credentials/windowsCredentialStore')
  >()),
  readWindowsCredentialSnapshot: mocks.read,
  restoreWindowsCredentialSnapshot: mocks.restore,
}));
vi.mock('@/shared/security/security', async () => {
  const { encryptWithKey, decryptParsedPayloadWithKey, parseEncryptedPayload } =
    await import('@/shared/security/crypto');
  const key = Buffer.alloc(32, 7);
  return {
    initializeMasterKey: mocks.initialize,
    encrypt: async (value: string) => encryptWithKey(key, value),
    decrypt: async (value: string) => {
      const parsed = parseEncryptedPayload(value);
      if (!parsed) {
        throw new Error('Invalid encrypted fixture');
      }
      return decryptParsedPayloadWithKey(key, parsed);
    },
  };
});

const platform = process.platform;
let directory: string;
let database: string;
let credential: WindowsCredentialSnapshot | null;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-ide-recovery-'));
  database = path.join(directory, 'User/globalStorage/state.vscdb');
  fs.mkdirSync(path.dirname(database), { recursive: true });
  fs.writeFileSync(database, 'fixture-db');
  vi.spyOn(os, 'homedir').mockReturnValue(directory);
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
  mocks.observe.mockReset().mockResolvedValue([]);
  mocks.initialize.mockReset().mockResolvedValue(undefined);
  credential = {
    flags: 0,
    username: 'synthetic',
    comment: 'original comment',
    targetAlias: null,
    persist: 2,
    payload: Buffer.from('synthetic-original-token').toString('base64'),
  };
  mocks.read.mockReset().mockImplementation(async () => credential);
  mocks.restore
    .mockReset()
    .mockImplementation(async (_target, saved: WindowsCredentialSnapshot | null) => {
      credential = saved;
    });
});
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
  expect(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
  fs.rmSync(directory, { recursive: true, force: true });
});
// Keep fixture paths native to the host while exercising Windows credential behavior.
const options = () => ({ userDataDir: directory, platform });

describe('Windows IDE credential recovery', () => {
  it('captures fresh stopped-client credentials once and restores exact file bytes', async () => {
    const tokenFile = getIdeStandaloneTokenPath();
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    const original = Buffer.from([0xff, 0, 1, 65]);
    fs.writeFileSync(tokenFile, original);
    const save = await prepareWindowsIdeRecovery(database);
    const stoppedCredential = { ...credential!, comment: 'flushed during shutdown' };
    credential = stoppedCredential;
    await save();
    const saved = fs.readFileSync(`${database}.account-switch.credentials.backup`, 'utf8');
    expect(JSON.parse(saved)).toEqual({
      version: 1,
      standalonePath: tokenFile,
      credential: stoppedCredential,
      standalone: { bytes: original.toString('base64'), mode: fs.statSync(tokenFile).mode & 0o777 },
    });
    expect(mocks.initialize).not.toHaveBeenCalled();
    credential = null;
    fs.writeFileSync(tokenFile, 'new-account');
    await save();
    expect(fs.readFileSync(`${database}.account-switch.credentials.backup`, 'utf8')).toBe(saved);
    await restoreWindowsIdeCredentials(options());
    expect(credential).toEqual(stoppedCredential);
    expect(fs.readFileSync(tokenFile)).toEqual(original);
  });
  it('restores absent native and standalone credentials by removing newly created entries', async () => {
    credential = null;
    await (
      await prepareWindowsIdeRecovery(database)
    )();
    writeIdeStandaloneToken({
      access_token: 'replacement',
      refresh_token: 'refresh',
      expiry_timestamp: 1900000000,
    });
    credential = {
      flags: 0,
      username: 'new',
      comment: null,
      targetAlias: null,
      persist: 2,
      payload: '',
    };
    await restoreWindowsIdeCredentials(options());
    expect(credential).toBeNull();
    expect(fs.existsSync(getIdeStandaloneTokenPath())).toBe(false);
  });
  it('captures and restores credentials without requiring an account-encryption key', async () => {
    mocks.initialize.mockRejectedValue(new Error('master key unavailable'));
    const original = structuredClone(credential);
    await (
      await prepareWindowsIdeRecovery(database)
    )();
    credential = null;
    await restoreWindowsIdeCredentials(options());
    expect(credential).toEqual(original);
    expect(mocks.initialize).not.toHaveBeenCalled();
  });
  it('refuses to recover shared credentials while any official client is running', async () => {
    await (
      await prepareWindowsIdeRecovery(database)
    )();
    mocks.observe.mockResolvedValueOnce([{ pid: 20 }]);
    await expect(restoreWindowsIdeCredentials(options())).rejects.toThrow('Close every');
    expect(mocks.restore).not.toHaveBeenCalled();
  });
  it('rejects corrupt backups before changing credentials', async () => {
    await (
      await prepareWindowsIdeRecovery(database)
    )();
    fs.writeFileSync(
      `${database}.account-switch.credentials.backup`,
      '{"credential":"synthetic-private-secret",',
    );
    await expect(restoreWindowsIdeCredentials(options())).rejects.toThrow(
      /^Credential backup contains invalid JSON$/,
    );
    expect(mocks.restore).not.toHaveBeenCalled();
  });
  it('preserves an unreadable existing backup during switch preflight', async () => {
    const backup = `${database}.account-switch.credentials.backup`;
    fs.writeFileSync(backup, 'corrupt');
    await expect(prepareWindowsIdeRecovery(database)).rejects.toThrow();
    expect(fs.readFileSync(backup, 'utf8')).toBe('corrupt');
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it('rejects authenticated but malformed recovery data before native restoration', async () => {
    const { encrypt } = await import('@/shared/security/security');
    await (
      await prepareWindowsIdeRecovery(database)
    )();
    const backup = `${database}.account-switch.credentials.backup`;
    const saved = {
      version: 1,
      standalonePath: getIdeStandaloneTokenPath(),
      credential,
      standalone: { bytes: 'invalid-base64!', mode: 0o600 },
    };
    fs.writeFileSync(backup, await encrypt(JSON.stringify(saved)));
    await expect(restoreWindowsIdeCredentials(options())).rejects.toThrow('does not match');
    expect(mocks.restore).not.toHaveBeenCalled();
  });
  it('still restores an encrypted recovery record when the original key is available', async () => {
    const { encrypt } = await import('@/shared/security/security');
    await (
      await prepareWindowsIdeRecovery(database)
    )();
    const backup = `${database}.account-switch.credentials.backup`;
    fs.writeFileSync(backup, await encrypt(fs.readFileSync(backup, 'utf8')));
    const original = structuredClone(credential);
    credential = null;
    await restoreWindowsIdeCredentials(options());
    expect(credential).toEqual(original);
    expect(mocks.initialize).toHaveBeenCalledOnce();
  });
  it('excludes concurrent switches during recovery and releases ownership after failure', async () => {
    await (
      await prepareWindowsIdeRecovery(database)
    )();
    let finish: (() => void) | undefined;
    mocks.restore.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const recovering = restoreWindowsIdeCredentials(options());
    void recovering.catch(() => {});
    const switchAction = vi.fn().mockResolvedValue(undefined);
    try {
      await vi.waitFor(() => expect(mocks.restore).toHaveBeenCalledOnce());
      await expect(
        runWithSwitchGuard('cloud-account-switch', switchAction, 'ide'),
      ).rejects.toThrow();
      expect(switchAction).not.toHaveBeenCalled();
    } finally {
      finish?.();
      await recovering;
    }
    mocks.restore.mockRejectedValueOnce(new Error('native restore failed'));
    await expect(restoreWindowsIdeCredentials(options())).rejects.toThrow('native restore failed');
    await runWithSwitchGuard('cloud-account-switch', switchAction, 'ide');
    expect(switchAction).toHaveBeenCalledOnce();
  });
  it('reports native restoration failure without claiming the standalone file was restored', async () => {
    await (
      await prepareWindowsIdeRecovery(database)
    )();
    writeIdeStandaloneToken({
      access_token: 'replacement',
      refresh_token: 'refresh',
      expiry_timestamp: 1900000000,
    });
    const before = fs.readFileSync(getIdeStandaloneTokenPath());
    mocks.restore.mockRejectedValueOnce(new Error('native restore failed'));
    await expect(restoreWindowsIdeCredentials(options())).rejects.toThrow('native restore failed');
    expect(fs.readFileSync(getIdeStandaloneTokenPath())).toEqual(before);
  });
  it('refuses a redirected standalone directory before restoring the native credential', async () => {
    await (
      await prepareWindowsIdeRecovery(database)
    )();
    const redirected = path.join(directory, 'redirected');
    fs.mkdirSync(redirected);
    fs.symlinkSync(redirected, path.join(directory, '.gemini'), 'junction');
    await expect(restoreWindowsIdeCredentials(options())).rejects.toThrow('not a regular');
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(fs.readdirSync(redirected)).toEqual([]);
  });
});
