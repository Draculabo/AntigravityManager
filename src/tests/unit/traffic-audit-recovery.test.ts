import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrafficAuditRepository } from '@/modules/proxy-gateway/audit/traffic-audit.repository';
import { recoverInterruptedAudit } from '@/modules/proxy-gateway/audit/traffic-audit-recovery';

vi.mock('better-sqlite3', async () => {
  const { createRequire } = await import('node:module');
  return {
    default: createRequire(import.meta.url)(process.env.AGM_TEST_SQLITE_MODULE ?? 'better-sqlite3'),
  };
});
let directory: string;
let databasePath: string;
let repository: TrafficAuditRepository | null;
const boundary = 10_000;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-audit-recovery-'));
  databasePath = path.join(directory, 'audit.db');
  repository = new TrafficAuditRepository(databasePath, 0);
  repository.execute({ operation: 'shutdown', payload: null });
  repository = null;
  const db = new Database(databasePath);
  try {
    const parent = db.prepare(
      "INSERT INTO request_logs(id,timestamp,method,url,protocol,traffic_class,request_headers,outcome) VALUES(?,?,'POST','/synthetic','openai',?,'{}','in_progress')",
    );
    parent.run('old', 1, 'model');
    parent.run('current', boundary, 'model');
    parent.run('system', 2, 'system');
    parent.run('completed', 1, 'model');
    db.exec(
      "UPDATE request_logs SET completed_at=3,outcome='completed',status=200,duration_ms=2 WHERE id='completed'",
    );
    db.exec(
      "INSERT INTO upstream_attempts(id,parent_id,attempt_index,timestamp,operation,endpoint,request_headers,outcome) VALUES('old-attempt','old',1,1,'generate','https://example.test','{}','in_progress')",
    );
    const payload = db.prepare(
      "INSERT INTO audit_payloads(id,request_id,kind,representation,state,created_at,logical_bytes) VALUES(?,?,'text','sanitized_text','writing',?,99)",
    );
    payload.run('old-body', 'old', 1);
    payload.run('current-body', 'current', boundary);
    db.exec(
      "INSERT INTO audit_payload_chunks(payload_id,seq,payload,byte_length) VALUES('old-body',0,X'707265666978',6)",
    );
    db.exec(
      "INSERT INTO request_body_refs(request_id,direction,payload_id) VALUES('old','request','old-body')",
    );
  } finally {
    db.close();
  }
});
afterEach(() => {
  vi.useRealTimers();
  repository?.execute({ operation: 'shutdown', payload: null });
  repository = null;
  vi.restoreAllMocks();
  const target = path.resolve(directory);
  if (
    path.dirname(target) !== path.resolve(os.tmpdir()) ||
    !path.basename(target).startsWith('agm-audit-recovery-')
  ) {
    throw new Error('Unexpected cleanup target');
  }
  fs.rmSync(target, { recursive: true, force: true });
});

describe('audit restart reconciliation', () => {
  it('recovers old captures without fabricating provider status, duration, tokens or success', () => {
    repository = new TrafficAuditRepository(databasePath, boundary);
    const detail = repository.execute({ operation: 'detail', payload: { id: 'old' } });
    expect(detail).toMatchObject({
      request: {
        outcome: 'capture_interrupted',
        status: null,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        responsePartial: true,
      },
      attempts: [{ outcome: 'capture_interrupted', status: null, durationMs: null }],
      bodies: [
        {
          state: 'incomplete',
          storedBytes: 6,
          chunkCount: 1,
          partial: true,
          droppedReason: 'worker_restart',
        },
      ],
    });
    expect(
      repository.execute({
        operation: 'bodyPage',
        payload: { bodyId: 'old-body', cursor: 0, limitBytes: 1024 },
      }),
    ).toMatchObject({ chunks: [{ data: 'prefix', sequence: 0 }] });
    expect(repository.execute({ operation: 'detail', payload: { id: 'current' } })).toMatchObject({
      request: { outcome: 'in_progress', completedAt: null },
    });
    expect(repository.execute({ operation: 'detail', payload: { id: 'completed' } })).toMatchObject(
      { request: { outcome: 'completed', status: 200, durationMs: 2 } },
    );
    expect(
      repository.execute({
        operation: 'list',
        payload: { limit: 20, offset: 0, statusMode: 'unfinished' },
      }),
    ).toMatchObject({ total: 1, items: [{ id: 'current', outcome: 'in_progress' }] });
    expect(
      repository.execute({
        operation: 'list',
        payload: { limit: 20, offset: 0, trafficClass: 'system' },
      }),
    ).toMatchObject({ total: 1, items: [{ id: 'system', outcome: 'capture_interrupted' }] });
  });
  it('makes reconciled parents eligible for eviction without deleting a current capture', () => {
    repository = new TrafficAuditRepository(databasePath, boundary);
    // Maintenance protects captures closed during the same millisecond as its snapshot.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 1);
    const maintenance = repository.maintenance({ maxRows: 1, maxDiskBytes: 16 * 1024 * 1024 });
    while (!maintenance.next().done) {
      /* Drive the cooperative pass synchronously in this repository check. */
    }
    expect(repository.execute({ operation: 'detail', payload: { id: 'old' } })).toBeNull();
    expect(repository.execute({ operation: 'detail', payload: { id: 'current' } })).toMatchObject({
      request: { outcome: 'in_progress', completedAt: null },
    });
  });

  it('retains the durable outcome/layout and is idempotent for a same-process Worker replacement', () => {
    repository = new TrafficAuditRepository(databasePath, boundary);
    const before = repository.execute({ operation: 'detail', payload: { id: 'old' } });
    repository.execute({ operation: 'shutdown', payload: null });
    repository = null;
    repository = new TrafficAuditRepository(databasePath, boundary);
    expect(repository.execute({ operation: 'detail', payload: { id: 'old' } })).toEqual(before);
    const db = new Database(databasePath, { readonly: true });
    try {
      expect(
        db.prepare('SELECT outcome,status,duration_ms FROM request_logs WHERE id=?').get('old'),
      ).toEqual({ outcome: 'in_progress', status: null, duration_ms: null });
      expect(db.prepare('SELECT state FROM audit_payloads WHERE id=?').get('current-body')).toEqual(
        { state: 'writing' },
      );
      expect(db.pragma('user_version', { simple: true })).toBe(7);
    } finally {
      db.close();
    }
  });
  it('rolls back all recovery effects and releases the connection if payload reconciliation fails', () => {
    const db = new Database(databasePath);
    db.exec(
      "CREATE TRIGGER fail_recovery BEFORE UPDATE ON audit_payloads BEGIN SELECT RAISE(ABORT,'synthetic recovery failure'); END",
    );
    db.close();
    expect(() => new TrafficAuditRepository(databasePath, boundary)).toThrow(
      'synthetic recovery failure',
    );
    const check = new Database(databasePath);
    try {
      expect(check.prepare('SELECT completed_at FROM request_logs WHERE id=?').get('old')).toEqual({
        completed_at: null,
      });
      expect(
        check.prepare('SELECT completed_at FROM upstream_attempts WHERE id=?').get('old-attempt'),
      ).toEqual({ completed_at: null });
      check.exec('DROP TRIGGER fail_recovery');
      recoverInterruptedAudit(check, boundary);
      expect(
        check.prepare('SELECT completed_at FROM request_logs WHERE id=?').get('old'),
      ).not.toEqual({ completed_at: null });
    } finally {
      check.close();
    }
  });
});
