import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureCloudAccountLifecycleSchema } from '@/modules/cloud-account/persistence/cloud-account-lifecycle-schema';

vi.mock('better-sqlite3', async () => {
  const { createRequire } = await import('node:module');
  return { default: createRequire(import.meta.url)('better-sqlite3') };
});

let directory: string;
let db: Database.Database;
const rowSchema = z.object({
  id: z.string(),
  value: z.string(),
  lifecycle_generation: z.string().regex(/^[a-f0-9]{32}$/),
});
const read = () => rowSchema.parse(db.prepare('SELECT * FROM accounts WHERE id = ?').get('one'));
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-incarnation-migration-'));
  db = new Database(path.join(directory, 'accounts.db'));
  db.exec('CREATE TABLE accounts (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT INTO accounts (id, value) VALUES (?, ?)').run('one', 'synthetic-original');
});
afterEach(() => {
  vi.restoreAllMocks();
  if (db.open) {
    db.close();
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('account incarnation migration and recovery', () => {
  it('backfills once, preserves values and keeps the same incarnation across reads, reopen and ordinary updates', () => {
    ensureCloudAccountLifecycleSchema(db);
    const first = read();
    ensureCloudAccountLifecycleSchema(db);
    expect(read()).toEqual(first);
    db.close();
    db = new Database(path.join(directory, 'accounts.db'));
    ensureCloudAccountLifecycleSchema(db);
    expect(read()).toEqual(first);
    db.prepare('UPDATE accounts SET value = ? WHERE id = ?').run('updated', 'one');
    expect(read()).toEqual({ ...first, value: 'updated' });
  });

  it('assigns a new incarnation to an old-release insert and to same-value recreation', () => {
    ensureCloudAccountLifecycleSchema(db);
    const first = read();
    // The old release names only its known columns; it never copies the storage incarnation.
    db.prepare('UPDATE accounts SET value = ? WHERE id = ?').run(first.value, first.id);
    expect(read()).toEqual(first);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(first.id);
    db.prepare('INSERT INTO accounts (id, value) VALUES (?, ?)').run(first.id, first.value);
    expect(read()).toMatchObject({ id: first.id, value: first.value });
    expect(read().lifecycle_generation).not.toBe(first.lifecycle_generation);
  });

  it('rolls back the column, backfill and trigger when migration fails, then allows an explicit retry', () => {
    const exec = db.exec.bind(db);
    const fail = vi.spyOn(db, 'exec').mockImplementation((sql) => {
      if (sql.includes('CREATE TRIGGER')) {
        throw new Error('synthetic migration failure');
      }
      return exec(sql);
    });
    expect(() => ensureCloudAccountLifecycleSchema(db)).toThrow('synthetic migration failure');
    expect(db.prepare('SELECT * FROM accounts').all()).toEqual([
      { id: 'one', value: 'synthetic-original' },
    ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()).toEqual([]);
    fail.mockRestore();
    ensureCloudAccountLifecycleSchema(db);
    expect(read().value).toBe('synthetic-original');
  });

  it('restores a stopped-owner pre-migration backup and migrates it without changing account data', async () => {
    const backup = path.join(directory, 'before.db');
    await db.backup(backup);
    ensureCloudAccountLifecycleSchema(db);
    db.prepare('UPDATE accounts SET value = ? WHERE id = ?').run('later-value', 'one');
    db.close();
    fs.copyFileSync(backup, path.join(directory, 'accounts.db'));
    db = new Database(path.join(directory, 'accounts.db'));
    ensureCloudAccountLifecycleSchema(db);
    expect(read().value).toBe('synthetic-original');
  });
});
