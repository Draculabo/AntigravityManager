import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ErrorWindowRepository } from '@/modules/error-diagnostics/error-window.repository';
import {
  ErrorWindowCommandSchema,
  ErrorWindowPageSchema,
} from '@/modules/error-diagnostics/error-window.schema';
import {
  decodeErrorRecord,
  encodeErrorRecord,
  MAX_ERROR_RECORD_BYTES,
} from '@/modules/error-diagnostics/error-record';
import { createDiagnosticErrorRecord } from '@/shared/observability/errorDiagnostic';
import { SqliteDiskAdmissionError } from '@/shared/persistence/database/sqlite-write-budget';

vi.mock('better-sqlite3', async () => {
  const { createRequire } = await import('node:module');
  return { default: createRequire(import.meta.url)('better-sqlite3') };
});

let directory: string;
const repositories: ErrorWindowRepository[] = [];
const connections: Database.Database[] = [];
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-error-window-'));
});
afterEach(() => {
  for (const raw of connections.splice(0)) {
    raw.close();
  }
  for (const repo of repositories.splice(0)) {
    execute(repo, 'shutdown', null);
  }
  expect(path.dirname(path.resolve(directory))).toBe(path.resolve(os.tmpdir()));
  expect(path.basename(directory).startsWith('agm-error-window-')).toBe(true);
  fs.rmSync(directory, { recursive: true, force: true });
});

function execute(repo: ErrorWindowRepository, operation: string, payload: unknown): unknown {
  return repo.execute(ErrorWindowCommandSchema.parse({ operation, payload }));
}
function open(allocationBytes = 64 * 1024 * 1024) {
  const generation = randomUUID();
  const file = path.join(directory, 'core.db');
  const repo = new ErrorWindowRepository(file, 'core');
  repositories.push(repo);
  execute(repo, 'initialize', { generation, allocationBytes });
  return { repo, generation, file };
}
function body(text = 'complete reasoning diagnostic') {
  const error = new Error('failure');
  error.stack = `Error: failure\n    at handler (file.ts:2:3)\n${text}`;
  const record = createDiagnosticErrorRecord({
    error,
    role: 'core',
    source: 'logger',
    category: 'decode-error',
    requestId: 'request-1',
    now: new Date('2020-01-01T00:00:00Z'),
  });
  const encoded = encodeErrorRecord(record);
  if (!encoded.accepted) {
    throw new Error('Expected a complete fixture');
  }
  return { record, body: encoded.body };
}
function raw(file: string) {
  const database = new Database(file);
  connections.push(database);
  return database;
}

it('retains complete sanitized Unicode diagnostics, bounded metadata and old records through reopen', () => {
  const first = open();
  const saved = body('帧😀\n'.repeat(20_000));
  expect(execute(first.repo, 'insert', { generation: first.generation, body: saved.body })).toEqual(
    { persisted: true, duplicate: false },
  );
  expect(execute(first.repo, 'insert', { generation: first.generation, body: saved.body })).toEqual(
    { persisted: true, duplicate: true },
  );
  const page = ErrorWindowPageSchema.parse(execute(first.repo, 'query', {}));
  expect(() =>
    execute(first.repo, 'insert', {
      generation: first.generation,
      body: saved.body.replace('"message":"failure"', '"message":"different"'),
    }),
  ).toThrow('identity conflict');
  expect(page.records).toHaveLength(1);
  expect(page.records[0]).toMatchObject({
    id: saved.record.id,
    source: 'logger',
    category: 'decode-error',
    message: 'failure',
  });
  expect(JSON.stringify(page)).not.toContain('at handler');
  expect(execute(first.repo, 'maintain', null)).toMatchObject({ removedRecords: 0 });
  execute(first.repo, 'shutdown', null);
  repositories.splice(repositories.indexOf(first.repo), 1);
  const reopened = open();
  expect(execute(reopened.repo, 'detail', { id: saved.record.id })).toEqual(
    decodeErrorRecord(saved.body),
  );
  expect(execute(reopened.repo, 'stats', null)).toMatchObject({ records: 1, role: 'core' });
});

it('keeps the query high-water mark stable while newer errors arrive', () => {
  const { repo, generation } = open();
  const saved = Array.from({ length: 4 }, () => body());
  for (const item of saved.slice(0, 3)) {
    execute(repo, 'insert', { generation, body: item.body });
  }
  const first = ErrorWindowPageSchema.parse(execute(repo, 'query', { limit: 2 }));
  execute(repo, 'insert', { generation, body: saved[3].body });
  const second = ErrorWindowPageSchema.parse(
    execute(repo, 'query', {
      limit: 2,
      afterSequence: first.nextSequence,
      throughSequence: first.throughSequence,
    }),
  );
  expect([...first.records, ...second.records].map((item) => item.id)).toEqual(
    saved.slice(0, 3).map((item) => item.record.id),
  );
  expect(second.complete).toBe(true);
  expect(second.nextSequence).toBeNull();
  expect(
    ErrorWindowPageSchema.parse(execute(repo, 'query', { source: 'missing' })).records,
  ).toEqual([]);
});

it('revokes old captures across clear and permits only new-generation errors', () => {
  const { repo, generation } = open();
  const saved = body();
  execute(repo, 'insert', { generation, body: saved.body });
  const next = randomUUID();
  expect(execute(repo, 'clear', { generation: next })).toEqual({ generation: next, records: 1 });
  expect(() => execute(repo, 'insert', { generation, body: saved.body })).toThrow(
    'cleared_generation',
  );
  expect(execute(repo, 'detail', { id: saved.record.id })).toBeNull();
  const fresh = body('fresh');
  execute(repo, 'insert', { generation: next, body: fresh.body });
  expect(
    ErrorWindowPageSchema.parse(execute(repo, 'query', {})).records.map((item) => item.id),
  ).toEqual([fresh.record.id]);
});

it('preserves durable rows after failed clear while still rejecting old capture generations', () => {
  const { repo, generation, file } = open();
  const saved = body();
  execute(repo, 'insert', { generation, body: saved.body });
  const database = raw(file);
  database.exec(
    "CREATE TRIGGER refuse_error_clear BEFORE DELETE ON error_window_records BEGIN SELECT RAISE(ABORT,'fixture clear refusal'); END;",
  );
  const next = randomUUID();
  expect(() => execute(repo, 'clear', { generation: next })).toThrow('fixture clear refusal');
  expect(execute(repo, 'detail', { id: saved.record.id })).toEqual(decodeErrorRecord(saved.body));
  expect(() => execute(repo, 'insert', { generation, body: saved.body })).toThrow(
    'cleared_generation',
  );
  database.exec('DROP TRIGGER refuse_error_clear');
  execute(repo, 'insert', { generation: next, body: body('fresh').body });
  expect(execute(repo, 'stats', null)).toMatchObject({ records: 2 });
});

it('bounds capacity slices and reclaims whole oldest records after a budget decrease', () => {
  const { repo, generation } = open(8 * 1024 * 1024);
  const saved = Array.from({ length: 80 }, () => body('frame\n'.repeat(1000)));
  for (const item of saved) {
    execute(repo, 'insert', { generation, body: item.body });
  }
  execute(repo, 'configure', { allocationBytes: 512 * 1024, generation });
  execute(repo, 'shutdown', null);
  repositories.splice(repositories.indexOf(repo), 1);
  const resumed = open(512 * 1024);
  const SliceSchema = z.object({
    removedRecords: z.number().int().max(32),
    databaseBytes: z.number(),
    moreWorkPending: z.boolean(),
    blockedReason: z.string().optional(),
  });
  let removed = 0;
  let last;
  for (let index = 0; index < 128; index += 1) {
    last = SliceSchema.parse(execute(resumed.repo, 'maintain', null));
    removed += last.removedRecords;
    if (!last.moreWorkPending) {
      break;
    }
  }
  expect(last?.blockedReason).toBeUndefined();
  expect(last?.databaseBytes).toBeLessThanOrEqual(Math.floor(512 * 1024 * 0.7));
  expect(removed).toBeGreaterThan(0);
  expect(execute(resumed.repo, 'detail', { id: saved[0].record.id })).toBeNull();
  const newest = saved.at(-1)!;
  expect(execute(resumed.repo, 'detail', { id: newest.record.id })).toEqual(
    decodeErrorRecord(newest.body),
  );
});

it('reports a busy external reader without silently deleting records or claiming reclaim success', () => {
  const { repo, generation, file } = open();
  execute(repo, 'insert', { generation, body: body('frame\n'.repeat(2000)).body });
  const reader = raw(file);
  reader.exec('BEGIN');
  reader.prepare('SELECT count(*) FROM error_window_records').get();
  for (let index = 0; index < 30; index += 1) {
    execute(repo, 'insert', { generation, body: body('frame\n'.repeat(2000)).body });
  }
  execute(repo, 'configure', { allocationBytes: 512 * 1024, generation });
  expect(execute(repo, 'maintain', null)).toMatchObject({
    removedRecords: 0,
    moreWorkPending: false,
    blockedReason: 'checkpoint_busy',
  });
  expect(execute(repo, 'stats', null)).toMatchObject({ records: 31 });
  reader.exec('ROLLBACK');
});

it('rejects new persistence under pressure while retaining readable existing errors', () => {
  const { repo, generation } = open(512 * 1024);
  const first = body('frame\n'.repeat(500));
  execute(repo, 'insert', { generation, body: first.body });
  let failure: unknown;
  for (let index = 0; index < 100; index += 1) {
    try {
      execute(repo, 'insert', { generation, body: body('frame\n'.repeat(500)).body });
    } catch (error) {
      failure = error;
      break;
    }
  }
  expect(failure).toBeInstanceOf(SqliteDiskAdmissionError);
  expect(execute(repo, 'detail', { id: first.record.id })).toEqual(decodeErrorRecord(first.body));
  expect(execute(repo, 'stats', null)).toMatchObject({ reclaiming: true });
});

it('refuses oversized stored bodies before decoding them and keeps metadata readable', () => {
  const { repo, generation, file } = open();
  const saved = body();
  execute(repo, 'insert', { generation, body: saved.body });
  const database = raw(file);
  database
    .prepare('UPDATE error_window_records SET body=? WHERE record_id=?')
    .run('x'.repeat(MAX_ERROR_RECORD_BYTES + 1), saved.record.id);
  expect(() => execute(repo, 'detail', { id: saved.record.id })).toThrow(
    'exceeds the record budget',
  );
  expect(ErrorWindowPageSchema.parse(execute(repo, 'query', {})).records).toHaveLength(1);
});

it('refuses future/unowned databases and mismatched roles without resetting their data', () => {
  const file = path.join(directory, 'unowned.db');
  const database = raw(file);
  database.exec(
    "CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('fixture'); PRAGMA user_version=2;",
  );
  expect(() => new ErrorWindowRepository(file, 'core')).toThrow(
    'Unsupported local error diagnostic schema',
  );
  expect(database.prepare('SELECT * FROM retained').all()).toEqual([{ value: 'fixture' }]);
  database.pragma('user_version = 0');
  expect(() => new ErrorWindowRepository(file, 'core')).toThrow('unowned objects');
  expect(database.prepare('SELECT * FROM retained').all()).toEqual([{ value: 'fixture' }]);
  const owned = open();
  expect(() => new ErrorWindowRepository(owned.file, 'app')).toThrow('role mismatch');
});
