import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { TrafficAuditRepository } from '@/modules/proxy-gateway/audit/traffic-audit.repository';
import { UpstreamAttemptTimingSchema } from '@/modules/proxy-gateway/audit/upstream-attempt-timing';

vi.mock('better-sqlite3', async () => {
  const { createRequire } = await import('node:module');
  return {
    default: createRequire(import.meta.url)(process.env.AGM_TEST_SQLITE_MODULE ?? 'better-sqlite3'),
  };
});

const timing = {
  version: 1,
  uploadFinishedMs: 0,
  responseHeadersMs: 20,
  firstByteMs: 21,
  firstUsableOutputMs: null,
} as const;
const directories: string[] = [];
const repositories = new Set<TrafficAuditRepository>();
function open(databasePath: string) {
  const repository = new TrafficAuditRepository(databasePath, 0);
  repositories.add(repository);
  return repository;
}
function close(repository: TrafficAuditRepository) {
  repository.execute({ operation: 'shutdown', payload: null });
  repositories.delete(repository);
}
afterEach(() => {
  for (const repository of repositories) {
    close(repository);
  }
  for (const directory of directories.splice(0)) {
    const target = path.resolve(directory);
    if (
      path.dirname(target) !== path.resolve(os.tmpdir()) ||
      !path.basename(target).startsWith('agm-attempt-timing-')
    ) {
      throw new Error('Unexpected cleanup target');
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
});

it('upgrades populated v6, preserves a readable restorable backup, and reopens stored timing', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-attempt-timing-'));
  directories.push(directory);
  const databasePath = path.join(directory, 'audit.db');
  close(open(databasePath));
  const previous = new Database(databasePath);
  try {
    previous.exec(
      "ALTER TABLE upstream_attempts DROP COLUMN timing_json; PRAGMA user_version=6; UPDATE schema_meta SET value='6' WHERE key='schema_version'; UPDATE schema_meta SET value='classified-chunked-payload-v6' WHERE key='layout';",
    );
    previous.exec(
      "INSERT INTO request_logs(id,timestamp,completed_at,method,url,protocol,traffic_class,request_headers,outcome) VALUES('parent',1,2,'POST','/synthetic','gemini','model','{}','completed');",
    );
    previous.exec(
      "INSERT INTO upstream_attempts(id,parent_id,attempt_index,timestamp,completed_at,operation,endpoint,request_headers,outcome) VALUES('attempt','parent',1,1,2,'generate','http://fixture.test','{}','completed');",
    );
    previous.exec(
      "INSERT INTO audit_payloads(id,request_id,kind,representation,state,created_at,logical_bytes,stored_bytes,chunk_count) VALUES('body','parent','text','sanitized_text','complete',1,7,7,1); INSERT INTO audit_payload_chunks(payload_id,seq,payload,byte_length) VALUES('body',0,X'66697874757265',7); INSERT INTO request_body_refs(request_id,direction,payload_id) VALUES('parent','request','body');",
    );
  } finally {
    previous.close();
  }
  let repository = open(databasePath);
  expect(repository.execute({ operation: 'detail', payload: { id: 'parent' } })).toMatchObject({
    attempts: [{ id: 'attempt', timing: null }],
  });
  const backups = fs
    .readdirSync(directory)
    .filter((file) => file.startsWith('audit.db.schema-v6-backup-'));
  expect(backups).toHaveLength(1);
  const backupPath = path.join(directory, backups[0]!);
  const backup = new Database(backupPath, { readonly: true });
  try {
    expect(backup.pragma('user_version', { simple: true })).toBe(6);
    expect(backup.prepare('SELECT payload FROM audit_payload_chunks').get()).toEqual({
      payload: Buffer.from('fixture'),
    });
    expect(backup.prepare('SELECT id,outcome FROM upstream_attempts').get()).toEqual({
      id: 'attempt',
      outcome: 'completed',
    });
  } finally {
    backup.close();
  }
  repository.execute({
    operation: 'completeAttempt',
    payload: {
      id: 'attempt',
      completedAt: 50,
      durationMs: 49,
      error: null,
      outcome: 'completed',
      responseHeaders: '{}',
      responsePartial: 0,
      status: 200,
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      reasoningTokens: null,
      timing,
    },
  });
  close(repository);
  repository = open(databasePath);
  expect(repository.execute({ operation: 'detail', payload: { id: 'parent' } })).toMatchObject({
    attempts: [{ timing }],
  });
  expect(
    fs.readdirSync(directory).filter((file) => file.startsWith('audit.db.schema-v6-backup-')),
  ).toEqual(backups);
  close(repository);
  const restoredPath = path.join(directory, 'restored.db');
  fs.copyFileSync(backupPath, restoredPath);
  repository = open(restoredPath);
  expect(repository.execute({ operation: 'detail', payload: { id: 'parent' } })).toMatchObject({
    attempts: [{ id: 'attempt', timing: null }],
    bodies: [{ storedBytes: 7 }],
  });
  close(repository);
  const future = new Database(databasePath);
  future.pragma('user_version=8');
  future.close();
  expect(() => open(databasePath)).toThrow('Unsupported traffic audit schema version: 8');
  const unchanged = new Database(databasePath, { readonly: true });
  try {
    expect(unchanged.pragma('user_version', { simple: true })).toBe(8);
    expect(unchanged.prepare('SELECT timing_json FROM upstream_attempts').get()).toEqual({
      timing_json: JSON.stringify(timing),
    });
  } finally {
    unchanged.close();
  }
});

it.each([-1, 0.5, Infinity, NaN])('rejects invalid observed milliseconds %s', (value) => {
  expect(UpstreamAttemptTimingSchema.safeParse({ ...timing, firstByteMs: value }).success).toBe(
    false,
  );
});
