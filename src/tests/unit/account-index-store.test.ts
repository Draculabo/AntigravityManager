import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Account } from '@/modules/account/types';
import {
  AccountIndexTransactionReentryError,
  mutateAccountIndex,
  readAccountIndex,
} from '@/modules/account/persistence/account-index-store';

const ACCOUNT_A: Account = {
  id: 'account-a',
  name: 'Alice',
  email: 'alice@example.com',
  created_at: '2026-09-04T00:00:00.000Z',
  last_used: '2026-09-04T00:00:00.000Z',
};

describe('account index store', () => {
  let tempDir: string;
  let indexPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-account-index-'));
    indexPath = path.join(tempDir, 'accounts.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function seedAccount(account: Account = ACCOUNT_A): Promise<void> {
    await mutateAccountIndex(indexPath, (draft) => {
      draft[account.id] = account;
    });
  }

  it('returns an empty detached snapshot only when the file does not exist', async () => {
    const snapshot = await readAccountIndex(indexPath);
    snapshot[ACCOUNT_A.id] = ACCOUNT_A;

    expect(await readAccountIndex(indexPath)).toEqual({});
  });

  it('loads an account index only after validating every stored account', async () => {
    fs.writeFileSync(indexPath, JSON.stringify({ [ACCOUNT_A.id]: ACCOUNT_A }), 'utf-8');

    expect(await readAccountIndex(indexPath)).toEqual({ [ACCOUNT_A.id]: ACCOUNT_A });
  });

  it('returns a detached callback result', async () => {
    const result = await mutateAccountIndex(indexPath, (draft) => {
      draft[ACCOUNT_A.id] = { ...ACCOUNT_A };
      return draft[ACCOUNT_A.id];
    });

    result.name = 'Changed outside transaction';

    expect((await readAccountIndex(indexPath))[ACCOUNT_A.id].name).toBe('Alice');
  });

  it('fails closed when an existing account index is malformed', async () => {
    const malformed = '{"account-a":';
    fs.writeFileSync(indexPath, malformed, 'utf-8');

    await expect(readAccountIndex(indexPath)).rejects.toThrow();
    expect(fs.readFileSync(indexPath, 'utf-8')).toBe(malformed);
  });

  it('fails closed when an existing account index has an invalid account shape', async () => {
    const invalidIndex = JSON.stringify({ 'account-a': { id: 'account-a' } });
    fs.writeFileSync(indexPath, invalidIndex, 'utf-8');

    await expect(readAccountIndex(indexPath)).rejects.toThrow();
    expect(fs.readFileSync(indexPath, 'utf-8')).toBe(invalidIndex);
  });

  it('rejects an asynchronous mutation callback without committing it', async () => {
    await expect(
      mutateAccountIndex(indexPath, async (draft) => {
        draft[ACCOUNT_A.id] = ACCOUNT_A;
      }),
    ).rejects.toThrow('must be synchronous');

    expect(fs.existsSync(indexPath)).toBe(false);
  });

  it('throws a stable error for a nested index transaction instead of deadlocking', async () => {
    await expect(
      mutateAccountIndex(indexPath, () =>
        readAccountIndex(path.join(tempDir, 'another-accounts.json')),
      ),
    ).rejects.toBeInstanceOf(AccountIndexTransactionReentryError);

    expect(fs.existsSync(indexPath)).toBe(false);
  });

  it('rejects a nested mutation transaction as the same stable error', async () => {
    await expect(
      mutateAccountIndex(indexPath, () =>
        mutateAccountIndex(path.join(tempDir, 'another-accounts.json'), () => undefined),
      ),
    ).rejects.toBeInstanceOf(AccountIndexTransactionReentryError);

    expect(fs.existsSync(indexPath)).toBe(false);
  });

  it('serializes concurrent mutations so each one reads the latest committed index', async () => {
    await Promise.all([
      mutateAccountIndex(indexPath, (draft) => {
        draft[ACCOUNT_A.id] = { ...ACCOUNT_A };
      }),
      mutateAccountIndex(indexPath, (draft) => {
        draft['account-b'] = {
          ...ACCOUNT_A,
          id: 'account-b',
          email: 'bob@example.com',
          name: 'Bob',
        };
      }),
    ]);

    expect(await readAccountIndex(indexPath)).toEqual({
      [ACCOUNT_A.id]: ACCOUNT_A,
      'account-b': {
        ...ACCOUNT_A,
        id: 'account-b',
        email: 'bob@example.com',
        name: 'Bob',
      },
    });
  });

  it('preserves the old bytes and original error when the callback throws', async () => {
    await seedAccount();
    const original = fs.readFileSync(indexPath, 'utf-8');
    const callbackError = new Error('callback failed');

    await expect(
      mutateAccountIndex(indexPath, (draft) => {
        draft[ACCOUNT_A.id].name = 'Uncommitted';
        throw callbackError;
      }),
    ).rejects.toBe(callbackError);

    expect(fs.readFileSync(indexPath, 'utf-8')).toBe(original);
  });

  it('validates the complete mutated index before writing', async () => {
    await seedAccount();
    const original = fs.readFileSync(indexPath, 'utf-8');
    const writeSpy = vi.spyOn(fs, 'writeFileSync');

    await expect(
      mutateAccountIndex(indexPath, (draft) => {
        draft.invalid = { id: 'invalid' } as Account;
      }),
    ).rejects.toThrow();

    expect(fs.readFileSync(indexPath, 'utf-8')).toBe(original);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('preserves the existing index when the temporary write fails', async () => {
    await seedAccount();
    const original = fs.readFileSync(indexPath, 'utf-8');
    const originalWrite = fs.writeFileSync.bind(fs);

    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      originalWrite(file, data, options);
      throw new Error('disk full');
    });

    await expect(mutateAccountIndex(indexPath, () => undefined)).rejects.toThrow('disk full');
    expect(fs.readFileSync(indexPath, 'utf-8')).toBe(original);
    expect(fs.readdirSync(tempDir)).toEqual(['accounts.json']);
  });

  it('preserves the existing index and cleans the temp file when replacement fails', async () => {
    await seedAccount();
    const original = fs.readFileSync(indexPath, 'utf-8');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('replace failed');
    });

    await expect(
      mutateAccountIndex(indexPath, (draft) => {
        draft[ACCOUNT_A.id].name = 'Uncommitted';
      }),
    ).rejects.toThrow('replace failed');

    expect(fs.readFileSync(indexPath, 'utf-8')).toBe(original);
    expect(fs.readdirSync(tempDir)).toEqual(['accounts.json']);
  });

  it('does not replace the primary write error when temp cleanup also fails', async () => {
    await seedAccount();
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('replace failed');
    });
    vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw new Error('cleanup failed');
    });

    await expect(mutateAccountIndex(indexPath, () => undefined)).rejects.toThrow('replace failed');
  });

  it('atomically replaces an existing target on the real filesystem without temp leftovers', async () => {
    await seedAccount();

    await mutateAccountIndex(indexPath, (draft) => {
      draft[ACCOUNT_A.id].name = 'Updated';
    });

    expect((await readAccountIndex(indexPath))[ACCOUNT_A.id].name).toBe('Updated');
    expect(fs.readdirSync(tempDir)).toEqual(['accounts.json']);
  });

  it('synchronizes the temporary index before replacing the durable account file', async () => {
    const sync = vi.spyOn(fs, 'fsyncSync');

    await seedAccount();

    expect(sync).toHaveBeenCalled();
  });

  it('uses distinct UUID-backed temp paths for separate commits', async () => {
    const open = vi.spyOn(fs, 'openSync');

    await seedAccount();
    await mutateAccountIndex(indexPath, (draft) => {
      draft[ACCOUNT_A.id].name = 'Updated';
    });

    const tempPaths = open.mock.calls
      .map(([file]) => String(file))
      .filter(
        (file) => file.startsWith(path.join(tempDir, '.accounts.json.')) && file.endsWith('.tmp'),
      );
    expect(tempPaths).toHaveLength(2);
    expect(new Set(tempPaths).size).toBe(2);
    expect(
      tempPaths.every((tempPath) => /\.accounts\.json\.[0-9a-f-]{36}\.tmp$/.test(tempPath)),
    ).toBe(true);
  });
});
