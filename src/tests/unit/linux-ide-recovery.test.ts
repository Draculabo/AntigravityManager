// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  prepareLinuxIdeRecovery,
  restoreLinuxIdeCredentials,
} from '@/modules/antigravity-runtime/credentials/linuxIdeRecovery';
import type { LinuxIdeCredentialSnapshot } from '@/modules/antigravity-runtime/credentials/linuxIdeCredentialStore';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  restore: vi.fn(),
  observe: vi.fn(),
  initialize: vi.fn(),
}));
vi.mock('@/modules/antigravity-runtime/credentials/linuxIdeCredentialStore', async (original) => ({
  ...(await original<
    typeof import('@/modules/antigravity-runtime/credentials/linuxIdeCredentialStore')
  >()),
  readLinuxIdeCredentialSnapshot: mocks.read,
  restoreLinuxIdeCredentialSnapshot: mocks.restore,
}));
vi.mock('@/modules/antigravity-runtime/processObserver', () => ({
  observeProcesses: mocks.observe,
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
let standalone: string;
let snapshot: LinuxIdeCredentialSnapshot;
const options = () => ({ userDataDir: directory, platform });

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-linux-recovery-'));
  database = path.join(directory, 'User/globalStorage/state.vscdb');
  standalone = path.join(directory, '.gemini/jetski-standalone-oauth-token');
  fs.mkdirSync(path.dirname(database), { recursive: true });
  fs.writeFileSync(database, 'fixture');
  snapshot = ['login', 'default'].map((collection) => ({
    path: `/org/freedesktop/secrets/collection/${collection}/1`,
    payload: Buffer.from(`${collection}-original\0`).toString('base64'),
    contentType: 'application/octet-stream',
  }));
  mocks.read.mockReset().mockImplementation(async () => structuredClone(snapshot));
  mocks.restore.mockReset().mockResolvedValue(undefined);
  mocks.observe.mockReset().mockResolvedValue([]);
  mocks.initialize.mockReset().mockResolvedValue(undefined);
  vi.spyOn(os, 'homedir').mockReturnValue(directory);
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('Linux IDE credential recovery', () => {
  it('captures fresh collection entries as JSON after shutdown and restores exact fallback bytes', async () => {
    const capture = await prepareLinuxIdeRecovery(database);
    snapshot[0].payload = Buffer.from('fresh-post-shutdown-secret').toString('base64');
    fs.mkdirSync(path.dirname(standalone));
    const original = Buffer.from('original-file\0\xff', 'latin1');
    fs.writeFileSync(standalone, original);
    await capture();
    const backup = `${database}.account-switch.linux-credentials.backup`;
    const saved = fs.readFileSync(backup);
    expect(JSON.parse(saved.toString())).toEqual({
      version: 1,
      standalonePath: standalone,
      credentials: snapshot,
      standalone: {
        bytes: original.toString('base64'),
        mode: fs.statSync(standalone).mode & 0o777,
      },
    });
    expect(mocks.initialize).not.toHaveBeenCalled();
    snapshot[0].payload = Buffer.from('replacement').toString('base64');
    fs.writeFileSync(standalone, 'replacement');
    await capture();
    expect(fs.readFileSync(backup)).toEqual(saved);
    await restoreLinuxIdeCredentials(options());
    expect(mocks.restore).toHaveBeenCalledExactlyOnceWith([
      { ...snapshot[0], payload: Buffer.from('fresh-post-shutdown-secret').toString('base64') },
      snapshot[1],
    ]);
    expect(fs.readFileSync(standalone)).toEqual(original);
  });
  it('does not require a master key for plain recovery records', async () => {
    mocks.initialize.mockRejectedValue(new Error('master key unavailable'));
    await (
      await prepareLinuxIdeRecovery(database)
    )();
    await restoreLinuxIdeCredentials(options());
    expect(mocks.restore).toHaveBeenCalledExactlyOnceWith(snapshot);
    expect(mocks.initialize).not.toHaveBeenCalled();
  });
  it('reads a historical encrypted record using the original key', async () => {
    const { encrypt } = await import('@/shared/security/security');
    await (
      await prepareLinuxIdeRecovery(database)
    )();
    const backup = `${database}.account-switch.linux-credentials.backup`;
    fs.writeFileSync(backup, await encrypt(fs.readFileSync(backup, 'utf8')));
    await restoreLinuxIdeCredentials(options());
    expect(mocks.restore).toHaveBeenCalledExactlyOnceWith(snapshot);
    expect(mocks.initialize).toHaveBeenCalledOnce();
  });
  it('preserves the absence of system items and fallback files', async () => {
    snapshot = [];
    await (
      await prepareLinuxIdeRecovery(database)
    )();
    fs.mkdirSync(path.dirname(standalone));
    fs.writeFileSync(standalone, 'new-file');
    await restoreLinuxIdeCredentials(options());
    expect(mocks.restore).toHaveBeenCalledExactlyOnceWith([]);
    expect(fs.existsSync(standalone)).toBe(false);
  });
  it('refuses recovery while an official client is running', async () => {
    await (
      await prepareLinuxIdeRecovery(database)
    )();
    mocks.observe.mockResolvedValueOnce([{ pid: 42 }]);
    await expect(restoreLinuxIdeCredentials(options())).rejects.toThrow('Close every');
    expect(mocks.restore).not.toHaveBeenCalled();
  });
  it('fails preflight when the native credential backup is unavailable', async () => {
    mocks.read.mockRejectedValueOnce(new Error('Secret Service unavailable'));
    await expect(prepareLinuxIdeRecovery(database)).rejects.toThrow('Secret Service unavailable');
    expect(fs.existsSync(`${database}.account-switch.linux-credentials.backup`)).toBe(false);
  });
  it('retains the fallback when native restoration fails', async () => {
    await (
      await prepareLinuxIdeRecovery(database)
    )();
    fs.mkdirSync(path.dirname(standalone));
    fs.writeFileSync(standalone, 'current');
    mocks.restore.mockRejectedValueOnce(new Error('native restore failed'));
    await expect(restoreLinuxIdeCredentials(options())).rejects.toThrow('native restore failed');
    expect(fs.readFileSync(standalone, 'utf8')).toBe('current');
  });
  it('rejects a redirected fallback directory before native mutation', async () => {
    await (
      await prepareLinuxIdeRecovery(database)
    )();
    const redirected = path.join(directory, 'redirected');
    fs.mkdirSync(redirected);
    fs.symlinkSync(redirected, path.dirname(standalone), 'junction');
    await expect(restoreLinuxIdeCredentials(options())).rejects.toThrow('not a regular');
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(fs.readdirSync(redirected)).toEqual([]);
  });
});
