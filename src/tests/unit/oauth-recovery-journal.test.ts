import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthRecoveryJournal } from '@/modules/cloud-account/persistence/oauth-recovery-journal';
import { decryptParsedPayloadWithKey, encryptWithKey, parseEncryptedPayload } from '@/shared/security/crypto';
import * as security from '@/shared/security/security';

const key = Buffer.alloc(32, 7);
const record = {
  version: 1 as const,
  accountId: 'account-1',
  expected: { access_token: 'old-access', refresh_token: 'old-refresh' },
  token: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, expiry_timestamp: 100, token_type: 'Bearer' },
};
let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-oauth-journal-'));
  vi.spyOn(security, 'encrypt').mockImplementation(async (value) => encryptWithKey(key, value));
  vi.spyOn(security, 'initializeMasterKey').mockResolvedValue({ state: 'secure' });
  vi.spyOn(security, 'decrypt').mockImplementation(async (value) => {
    const payload = parseEncryptedPayload(value);
    if (!payload) {
      throw new Error('Invalid encrypted data');
    }
    return decryptParsedPayloadWithKey(key, payload);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('OAuth recovery journal', () => {
  it('persists encrypted immutable entries readable by a new instance', async () => {
    const journal = new OAuthRecoveryJournal(directory);
    const name = await journal.append(record);
    const raw = await fs.readFile(path.join(directory, name), 'utf8');
    expect(raw).not.toContain(record.token.refresh_token);
    const restarted = new OAuthRecoveryJournal(directory);
    expect(await restarted.readAll()).toEqual([{ name, record }]);
    expect(security.initializeMasterKey).toHaveBeenLastCalledWith({ encryptedSamples: [raw] });
    await restarted.remove(name);
    expect(await restarted.readAll()).toEqual([]);
  });

  it('initializes the key for a journal directory that does not exist yet', async () => {
    const journal = new OAuthRecoveryJournal(path.join(directory, 'new'));
    await journal.append(record);
    expect(security.initializeMasterKey).toHaveBeenCalledWith({ encryptedSamples: [] });
  });

  it('does not require a keyring to read an empty or missing journal', async () => {
    vi.mocked(security.initializeMasterKey).mockRejectedValue(new Error('key unavailable'));
    await expect(new OAuthRecoveryJournal(directory).readAll()).resolves.toEqual([]);
    await expect(new OAuthRecoveryJournal(path.join(directory, 'missing')).readAll()).resolves.toEqual([]);
    expect(security.initializeMasterKey).not.toHaveBeenCalled();
    await expect(new OAuthRecoveryJournal(directory).append(record)).rejects.toThrow('key unavailable');
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('does not overwrite evidence when key initialization fails', async () => {
    const journal = new OAuthRecoveryJournal(directory);
    const name = await journal.append(record);
    const before = await fs.readFile(path.join(directory, name), 'utf8');
    vi.mocked(security.initializeMasterKey).mockRejectedValueOnce(new Error('key unavailable'));
    await expect(journal.append(record)).rejects.toThrow('key unavailable');
    expect(await fs.readdir(directory)).toEqual([name]);
    expect(await fs.readFile(path.join(directory, name), 'utf8')).toBe(before);
  });

  it('fails closed on plaintext or corrupted journal entries', async () => {
    const journal = new OAuthRecoveryJournal(directory);
    const name = await journal.append(record);
    await fs.writeFile(path.join(directory, name), JSON.stringify(record));
    await expect(journal.readAll()).rejects.toThrow('Invalid OAuth recovery journal entry');
    expect(await fs.readFile(path.join(directory, name), 'utf8')).toBe(JSON.stringify(record));
  });

  it('rejects paths outside the journal', async () => {
    await expect(new OAuthRecoveryJournal(directory).remove('../other')).rejects.toThrow();
  });

  it('does not persist an encrypted entry larger than the reader accepts', async () => {
    vi.mocked(security.encrypt).mockResolvedValueOnce(`agm_enc_v1:aa:bb:${'ab'.repeat(262_251)}`);
    await expect(new OAuthRecoveryJournal(directory).append(record)).rejects.toThrow('Invalid OAuth recovery journal entry');
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('preserves ambiguous entries rather than guessing rotation order', async () => {
    const journal = new OAuthRecoveryJournal(directory);
    const first = await journal.append(record);
    const second = `${randomUUID()}.recovery`;
    await fs.copyFile(path.join(directory, first), path.join(directory, second));
    await expect(journal.readAll()).rejects.toThrow('Ambiguous OAuth recovery journal');
    expect((await fs.readdir(directory)).sort()).toEqual([first, second].sort());
  });

  it('serializes simultaneous appends across instances and rejects duplicate accounts', async () => {
    const results = await Promise.allSettled([
      new OAuthRecoveryJournal(directory).append(record),
      new OAuthRecoveryJournal(directory).append(record),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await new OAuthRecoveryJournal(directory).readAll()).toHaveLength(1);
  });

  it('reads entries for separate accounts', async () => {
    const journal = new OAuthRecoveryJournal(directory);
    await journal.append(record);
    await journal.append({ ...record, accountId: 'account-2' });
    expect((await journal.readAll()).map((entry) => entry.record.accountId).sort()).toEqual([
      'account-1',
      'account-2',
    ]);
  });
});
