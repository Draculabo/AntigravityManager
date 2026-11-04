import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { convertEncryptedAccountFields } from '@/modules/cloud-account/persistence/convert-encrypted-account-fields';
import { getCloudDb } from '@/modules/cloud-account/persistence/cloud-account-db';

const mocks = vi.hoisted(() => ({
  directory: '',
  initializeMasterKey: vi.fn(async () => {}),
  decryptWithMigration: vi.fn(async (value: string) => ({ value })),
}));
vi.mock('better-sqlite3', async () => {
  const { createRequire } = await import('node:module');
  return { default: createRequire(import.meta.url)('better-sqlite3') };
});
vi.mock('@/shared/platform/paths', () => ({
  getCloudAccountsDbPath: () => path.join(mocks.directory, 'cloud_accounts.db'),
}));
vi.mock('@/shared/security/security', () => ({
  initializeMasterKey: mocks.initializeMasterKey,
  decryptWithMigration: mocks.decryptWithMigration,
}));

const token = JSON.stringify({
  access_token: 'synthetic-access',
  refresh_token: 'synthetic-refresh',
  expires_in: 3600,
  expiry_timestamp: 4102444800,
  token_type: 'Bearer',
  future_field: { keep: true },
});
const ciphertext = 'agm_enc_v1:0011:2233:4455';
const quotaCiphertext = 'agm_enc_v1:0011:2233:6677';
const healthCiphertext = 'agm_enc_v1:0011:2233:8899';
const quota = JSON.stringify({ models: {} });
const health = JSON.stringify({ oauth: { refresh_blocked: false } });
const dbPath = () => path.join(mocks.directory, 'cloud_accounts.db');

function readSnapshot(file = dbPath()) {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return {
      accounts: z
        .array(z.looseObject({ id: z.string() }))
        .parse(database.prepare('SELECT * FROM accounts ORDER BY id').all()),
      settings: database.prepare('SELECT * FROM settings ORDER BY key').all(),
      workspaces: database.prepare('SELECT * FROM workspace_profiles ORDER BY id').all(),
      integrity: database.pragma('quick_check', { simple: true }),
    };
  } finally {
    database.close();
  }
}

function backupPairs(): string[] {
  return fs
    .readdirSync(mocks.directory)
    .filter((name) => name.startsWith('cloud_accounts.db.account-migration-'))
    .map((name) => path.join(mocks.directory, name));
}

function seed() {
  const { raw } = getCloudDb();
  try {
    raw
      .prepare(
        `INSERT INTO accounts
       (id, provider, email, token_json, quota_json, health_json, created_at, last_used, is_active)
       VALUES (?, 'google', ?, ?, ?, ?, 1700000000, 1700000001, ?)`,
      )
      .run(
        'encrypted',
        'encrypted@example.invalid',
        ciphertext,
        quotaCiphertext,
        healthCiphertext,
        1,
      );
    raw
      .prepare(
        `INSERT INTO accounts
       (id, provider, email, token_json, created_at, last_used)
       VALUES ('plain', 'google', 'plain@example.invalid', ?, 1700000002, 1700000003)`,
      )
      .run(token);
    raw
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run('active_cloud_account', 'encrypted');
    raw
      .prepare(
        `INSERT INTO workspace_profiles
       (id, name, account_id, project_path, user_data_dir, created_at)
       VALUES ('workspace', 'Synthetic workspace', 'encrypted', '/synthetic/project', '/synthetic/profile', 1700000000)`,
      )
      .run();
  } finally {
    raw.close();
  }
}

beforeEach(() => {
  mocks.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-account-conversion-'));
  vi.resetAllMocks();
  mocks.initializeMasterKey.mockResolvedValue(undefined);
  mocks.decryptWithMigration.mockImplementation(async (value: string) => {
    const decoded = new Map([
      [ciphertext, token],
      [quotaCiphertext, quota],
      [healthCiphertext, health],
    ]).get(value);
    if (!decoded) {
      throw new Error('Unexpected synthetic ciphertext');
    }
    return { value: decoded };
  });
  seed();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(mocks.directory, { recursive: true, force: true });
});

describe('convertEncryptedAccountFields', () => {
  it('preserves both complete databases before committing plaintext accounts', async () => {
    // Keep committed data in WAL while the online backup runs.
    const writer = new Database(dbPath());
    try {
      writer.pragma('wal_autocheckpoint = 0');
      writer
        .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
        .run('wal-only', 'preserved');
      const original = readSnapshot();
      expect(fs.statSync(`${dbPath()}-wal`).size).toBeGreaterThan(0);
      const rename = fs.renameSync;
      let observedBeforeCommit = false;
      vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
        rename(source, destination);
        if (String(destination).endsWith('decrypted.db')) {
          observedBeforeCommit = true;
          const pair = path.dirname(String(destination));
          expect(readSnapshot(path.join(pair, 'encrypted.db'))).toEqual(original);
          expect(readSnapshot()).toEqual(original);
        }
      });

      await convertEncryptedAccountFields();

      expect(observedBeforeCommit).toBe(true);
      expect(mocks.initializeMasterKey).toHaveBeenCalledOnce();
      const [pair] = backupPairs();
      expect(backupPairs()).toHaveLength(1);
      expect(fs.readdirSync(pair).sort()).toEqual(['decrypted.db', 'encrypted.db']);
      expect(readSnapshot(path.join(pair, 'encrypted.db'))).toEqual(original);
      const expected = {
        ...original,
        accounts: original.accounts.map((row) => {
          return row.id === 'encrypted'
            ? { ...row, token_json: token, quota_json: quota, health_json: health }
            : row;
        }),
      };
      expect(readSnapshot()).toEqual(expected);
      expect(readSnapshot(path.join(pair, 'decrypted.db'))).toEqual(expected);
      if (process.platform !== 'win32') {
        expect(fs.statSync(pair).mode & 0o777).toBe(0o700);
        for (const name of ['encrypted.db', 'decrypted.db']) {
          expect(fs.statSync(path.join(pair, name)).mode & 0o777).toBe(0o600);
        }
      }
    } finally {
      writer.close();
    }
  });

  it('restores an independently copied plaintext backup without the original key', async () => {
    await convertEncryptedAccountFields();
    const [pair] = backupPairs();
    const converted = readSnapshot();
    fs.copyFileSync(path.join(pair, 'decrypted.db'), dbPath());
    mocks.initializeMasterKey.mockReset().mockRejectedValue(new Error('original key unavailable'));
    mocks.decryptWithMigration.mockReset().mockRejectedValue(new Error('original key unavailable'));

    await convertEncryptedAccountFields();

    expect(readSnapshot()).toEqual(converted);
    expect(mocks.initializeMasterKey).not.toHaveBeenCalled();
    expect(mocks.decryptWithMigration).not.toHaveBeenCalled();
    expect(backupPairs()).toEqual([pair]);
  });

  it('retains earlier pairs when an encrypted backup is restored and migrated again', async () => {
    await convertEncryptedAccountFields();
    const [first] = backupPairs();
    const encrypted = fs.readFileSync(path.join(first, 'encrypted.db'));
    const decrypted = fs.readFileSync(path.join(first, 'decrypted.db'));
    fs.copyFileSync(path.join(first, 'encrypted.db'), dbPath());

    await convertEncryptedAccountFields();

    expect(backupPairs()).toHaveLength(2);
    expect(fs.readFileSync(path.join(first, 'encrypted.db'))).toEqual(encrypted);
    expect(fs.readFileSync(path.join(first, 'decrypted.db'))).toEqual(decrypted);
  });

  it('keeps encrypted rows unchanged when the encrypted backup fails', async () => {
    const original = readSnapshot();
    vi.spyOn(Database.prototype, 'backup').mockRejectedValueOnce(new Error('backup failed'));

    await expect(convertEncryptedAccountFields()).rejects.toThrow('backup failed');

    expect(readSnapshot()).toEqual(original);
  });

  it('keeps encrypted rows and the encrypted backup when plaintext publication fails', async () => {
    const original = readSnapshot();
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (String(destination).endsWith('decrypted.db')) {
        throw new Error('plaintext backup publication failed');
      }
      rename(source, destination);
    });

    await expect(convertEncryptedAccountFields()).rejects.toThrow(
      'plaintext backup publication failed',
    );

    expect(readSnapshot()).toEqual(original);
    const [pair] = backupPairs();
    expect(readSnapshot(path.join(pair, 'encrypted.db'))).toEqual(original);
    expect(fs.existsSync(path.join(pair, 'decrypted.db'))).toBe(false);
    vi.restoreAllMocks();
    await convertEncryptedAccountFields();
    expect(backupPairs()).toHaveLength(2);
    expect(readSnapshot(path.join(pair, 'encrypted.db'))).toEqual(original);
  });

  it('refuses a published plaintext backup whose persisted fields do not match', async () => {
    const original = readSnapshot();
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      rename(source, destination);
      if (String(destination).endsWith('decrypted.db')) {
        const database = new Database(String(destination));
        try {
          database.prepare('DELETE FROM accounts WHERE id = ?').run('plain');
        } finally {
          database.close();
        }
      }
    });

    await expect(convertEncryptedAccountFields()).rejects.toThrow();

    expect(readSnapshot()).toEqual(original);
  });

  it('keeps both backups if the final live transaction fails', async () => {
    const original = readSnapshot();
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      rename(source, destination);
      if (String(destination).endsWith('decrypted.db')) {
        const database = new Database(dbPath());
        try {
          database.exec(`
            CREATE TRIGGER reject_live_conversion BEFORE UPDATE OF token_json ON accounts
            BEGIN SELECT RAISE(ABORT, 'synthetic conversion failure'); END;
          `);
        } finally {
          database.close();
        }
      }
    });

    await expect(convertEncryptedAccountFields()).rejects.toThrow('synthetic conversion failure');

    expect(readSnapshot()).toEqual(original);
    const [pair] = backupPairs();
    expect(readSnapshot(path.join(pair, 'encrypted.db'))).toEqual(original);
    expect(readSnapshot(path.join(pair, 'decrypted.db')).accounts).not.toEqual(original.accounts);
  });

  it('keeps live rows unchanged if the converted candidate cannot be written', async () => {
    const database = new Database(dbPath());
    try {
      database.exec(`
        CREATE TRIGGER reject_conversion BEFORE UPDATE OF token_json ON accounts
        BEGIN SELECT RAISE(ABORT, 'synthetic candidate failure'); END;
      `);
    } finally {
      database.close();
    }
    const original = readSnapshot();

    await expect(convertEncryptedAccountFields()).rejects.toThrow('synthetic candidate failure');

    expect(readSnapshot()).toEqual(original);
    const [pair] = backupPairs();
    expect(readSnapshot(path.join(pair, 'encrypted.db'))).toEqual(original);
    expect(fs.existsSync(path.join(pair, 'decrypted.db'))).toBe(false);
  });

  it('refuses account changes made after the backup pair was created', async () => {
    const original = readSnapshot();
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      rename(source, destination);
      if (String(destination).endsWith('decrypted.db')) {
        const database = new Database(dbPath());
        try {
          database.prepare('DELETE FROM accounts WHERE id = ?').run('plain');
        } finally {
          database.close();
        }
      }
    });

    await expect(convertEncryptedAccountFields()).rejects.toThrow('Account fields changed');

    expect(readSnapshot()).toEqual({
      ...original,
      accounts: original.accounts.filter((row) => row.id !== 'plain'),
    });
    const [pair] = backupPairs();
    expect(readSnapshot(path.join(pair, 'encrypted.db'))).toEqual(original);
  });

  it('does not overwrite an account updated while the key provider was awaited', async () => {
    mocks.initializeMasterKey.mockImplementationOnce(async () => {
      const database = new Database(dbPath());
      try {
        database.prepare('UPDATE accounts SET token_json = ? WHERE id = ?').run(token, 'encrypted');
      } finally {
        database.close();
      }
    });

    await expect(convertEncryptedAccountFields()).rejects.toThrow();

    const database = new Database(dbPath(), { readonly: true });
    try {
      expect(
        database.prepare('SELECT token_json FROM accounts WHERE id = ?').pluck().get('encrypted'),
      ).toBe(token);
    } finally {
      database.close();
    }
  });

  it('leaves plaintext accounts untouched without loading a key or creating backups', async () => {
    const database = new Database(dbPath());
    try {
      database.prepare('DELETE FROM accounts WHERE id = ?').run('encrypted');
    } finally {
      database.close();
    }
    const original = readSnapshot();

    await convertEncryptedAccountFields();

    expect(readSnapshot()).toEqual(original);
    expect(mocks.initializeMasterKey).not.toHaveBeenCalled();
    expect(backupPairs()).toEqual([]);
  });

  it('leaves the database untouched when the original key is unavailable', async () => {
    const original = readSnapshot();
    mocks.initializeMasterKey.mockRejectedValueOnce(new Error('original key unavailable'));

    await expect(convertEncryptedAccountFields()).rejects.toThrow('original key unavailable');

    expect(readSnapshot()).toEqual(original);
    expect(backupPairs()).toEqual([]);
  });

  it('leaves the database untouched when a decoded field is invalid', async () => {
    const original = readSnapshot();
    mocks.decryptWithMigration.mockResolvedValueOnce({ value: '{"access_token":"invalid"}' });

    await expect(convertEncryptedAccountFields()).rejects.toThrow();

    expect(readSnapshot()).toEqual(original);
    expect(backupPairs()).toEqual([]);
  });
});
