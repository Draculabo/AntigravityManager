import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WindowsCredentialSnapshot } from '@/modules/antigravity-runtime/credentials/windowsCredentialStore';
import type { ClientAccountCredentials } from '@/modules/antigravity-runtime/credentials/clientAccount';
import { prepareClientAccountWrite } from '@/modules/antigravity-runtime/credentials/clientAccountWrite';

const vault = vi.hoisted(() => ({
  readWindowsCredentialSnapshot: vi.fn(),
  restoreWindowsCredentialSnapshot: vi.fn(),
  readWindowsCredential: vi.fn(),
  writeWindowsCredential: vi.fn(),
}));

vi.mock(
  '@/modules/antigravity-runtime/credentials/windowsCredentialStore',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@/modules/antigravity-runtime/credentials/windowsCredentialStore')
    >()),
    ...vault,
  }),
);

const selected: ClientAccountCredentials = {
  email: 'selected@example.invalid',
  name: 'Selected',
  token: {
    access_token: 'synthetic-access',
    refresh_token: 'synthetic-refresh',
    expiry_timestamp: 1_800_000_000,
  },
};

function snapshot(payload: string): WindowsCredentialSnapshot {
  return {
    flags: 0,
    username: 'antigravity',
    comment: null,
    targetAlias: null,
    persist: 2,
    payload: Buffer.from(payload).toString('base64'),
  };
}

describe('Windows agy account switch recovery', () => {
  let home: string;
  let files: string[];
  let initial: WindowsCredentialSnapshot | null;
  let current: WindowsCredentialSnapshot | null;

  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-agy-write-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    const gemini = path.join(home, '.gemini');
    files = [
      path.join(gemini, 'antigravity-cli', 'antigravity-oauth-token'),
      path.join(gemini, 'oauth_creds.json'),
      path.join(gemini, 'google_accounts.json'),
    ];
    fs.mkdirSync(path.dirname(files[0]), { recursive: true });
    initial = { ...snapshot('original'), persist: 3, comment: 'original metadata' };
    current = initial;
    vault.readWindowsCredentialSnapshot.mockReset().mockImplementation(async () => current);
    vault.restoreWindowsCredentialSnapshot
      .mockReset()
      .mockImplementation(async (_target, saved) => {
        current = saved;
      });
    vault.readWindowsCredential.mockReset().mockImplementation(async () => {
      return current ? Buffer.from(current.payload, 'base64').toString() : null;
    });
    vault.writeWindowsCredential.mockReset().mockImplementation(async (_target, _name, payload) => {
      current = snapshot(payload);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('writes and verifies the selected account in all four stores', async () => {
    await (await prepareClientAccountWrite(selected, 'agy')).write();
    expect(fs.readFileSync(files[0], 'utf8')).toContain(selected.token.refresh_token);
    expect(fs.readFileSync(files[1], 'utf8')).toContain(selected.token.refresh_token);
    expect(JSON.parse(fs.readFileSync(files[2], 'utf8')).active).toBe(selected.email);
    expect(Buffer.from(current?.payload ?? '', 'base64').toString()).toContain(selected.email);
  });

  it('restores exact prior presence and bytes when the vault rejects the write', async () => {
    const cliBytes = Buffer.from('prior CLI\r\n');
    const accounts = '{ "active": "prior@example.invalid", "old": [] }';
    fs.writeFileSync(files[0], cliBytes);
    fs.writeFileSync(files[2], accounts);
    const primary = new Error('fixture vault write rejected');
    vault.writeWindowsCredential.mockRejectedValueOnce(primary);

    await expect((await prepareClientAccountWrite(selected, 'agy')).write()).rejects.toMatchObject({
      primary,
      rollback: 'succeeded',
    });
    expect(fs.readFileSync(files[0])).toEqual(cliBytes);
    expect(fs.existsSync(files[1])).toBe(false);
    expect(fs.readFileSync(files[2], 'utf8')).toBe(accounts);
    expect(current).toEqual(initial);
  });

  it.each([true, false])(
    'restores the vault after a failed readback (present: %s)',
    async (present) => {
      if (!present) {
        initial = null;
        current = null;
      }
      vault.readWindowsCredential.mockRejectedValueOnce(new Error('fixture readback unavailable'));
      await expect(
        (await prepareClientAccountWrite(selected, 'agy')).write(),
      ).rejects.toMatchObject({
        rollback: 'succeeded',
      });
      expect(current).toEqual(initial);
      expect(files.some((file) => fs.existsSync(file))).toBe(false);
    },
  );

  it('restores earlier files if the accounts file is malformed', async () => {
    fs.writeFileSync(files[2], 'malformed accounts file');
    await expect((await prepareClientAccountWrite(selected, 'agy')).write()).rejects.toMatchObject({
      rollback: 'succeeded',
    });
    expect(files.slice(0, 2).some((file) => fs.existsSync(file))).toBe(false);
    expect(fs.readFileSync(files[2], 'utf8')).toBe('malformed accounts file');
    expect(current).toEqual(initial);
  });

  it('leaves an oversized credential file intact and restores earlier writes', async () => {
    const oversized = Buffer.alloc(512 * 1024 + 1, 0x20);
    fs.writeFileSync(files[1], oversized);
    await expect((await prepareClientAccountWrite(selected, 'agy')).write()).rejects.toMatchObject({
      rollback: 'succeeded',
    });
    expect(fs.readFileSync(files[1]).equals(oversized)).toBe(true);
    expect(fs.existsSync(files[0])).toBe(false);
    expect(fs.existsSync(files[2])).toBe(false);
    expect(current).toEqual(initial);
  });

  it('preserves concurrent updates and reports incomplete recovery', async () => {
    const other = snapshot('external account');
    vault.writeWindowsCredential.mockImplementationOnce(async () => {
      current = other;
      fs.writeFileSync(files[0], 'external CLI');
      throw new Error('fixture write outcome uncertain');
    });
    await expect((await prepareClientAccountWrite(selected, 'agy')).write()).rejects.toMatchObject({
      rollback: 'failed',
    });
    expect(current).toEqual(other);
    expect(fs.readFileSync(files[0], 'utf8')).toBe('external CLI');
    expect(files.slice(1).some((file) => fs.existsSync(file))).toBe(false);
  });
});
