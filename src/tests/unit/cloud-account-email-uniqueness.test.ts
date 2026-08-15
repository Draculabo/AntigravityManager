import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureDatabaseInitialized } from '@/modules/cloud-account/persistence/cloud-account-db';

describe('cloud account email uniqueness', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-cloud-account-email-'));
    dbPath = path.join(tempDir, 'cloud-accounts.db');
    ensureDatabaseInitialized(dbPath);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function insertAccount(
    db: Database.Database,
    input: { id: string; provider: string; email: string },
  ): void {
    db.prepare(
      `INSERT INTO accounts (
        id,
        provider,
        email,
        token_json,
        created_at,
        last_used
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(input.id, input.provider, input.email, '{}', 1, 1);
  }

  it('rejects a second account with the same provider and email case-insensitively', () => {
    const db = new Database(dbPath);
    try {
      insertAccount(db, { id: 'account-a', provider: 'google', email: 'User@example.com' });

      expect(() =>
        insertAccount(db, { id: 'account-b', provider: 'google', email: 'user@example.com' }),
      ).toThrow(/duplicate cloud account email/i);
    } finally {
      db.close();
    }
  });

  it('allows the same email for a different provider', () => {
    const db = new Database(dbPath);
    try {
      insertAccount(db, { id: 'account-a', provider: 'google', email: 'user@example.com' });

      expect(() =>
        insertAccount(db, { id: 'account-b', provider: 'other', email: 'USER@example.com' }),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('rejects updates that would collide with another provider and email pair', () => {
    const db = new Database(dbPath);
    try {
      insertAccount(db, { id: 'account-a', provider: 'google', email: 'first@example.com' });
      insertAccount(db, { id: 'account-b', provider: 'google', email: 'second@example.com' });

      expect(() =>
        db
          .prepare('UPDATE accounts SET email = ? WHERE id = ?')
          .run('FIRST@example.com', 'account-b'),
      ).toThrow(/duplicate cloud account email/i);
    } finally {
      db.close();
    }
  });
});
