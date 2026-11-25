import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { TrafficAuditDiskBudget } from '@/modules/proxy-gateway/audit/traffic-audit-disk-budget';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrafficAuditRepository } from '@/modules/proxy-gateway/audit/traffic-audit.repository';
import { createTrafficAuditWorkerDispatcher } from '@/modules/proxy-gateway/audit/traffic-audit-worker-dispatcher';
import type { TrafficAuditWorkerCommand } from '@/modules/proxy-gateway/audit/traffic-audit.worker-protocol';

vi.mock('better-sqlite3', async () => {
  const { createRequire } = await import('node:module');
  return { default: createRequire(import.meta.url)('better-sqlite3') };
});

let directory: string;
let databasePath: string;
let repository: TrafficAuditRepository;
let shutdownRepository: () => void;
const generousBudget = 16 * 1024 * 1024;
function parent(id: string): TrafficAuditWorkerCommand & { operation: 'insertParent' } {
  return {
    operation: 'insertParent',
    payload: {
      clientIp: null,
      id,
      method: 'POST',
      model: null,
      operation: null,
      protocol: 'openai',
      requestHeaders: '{}',
      requestQuery: null,
      sessionId: null,
      timestamp: Date.now(),
      trafficClass: 'model',
      url: '/v1/chat/completions',
      username: null,
    },
  };
}
function begin(): void {
  repository.execute(parent('controlled'), generousBudget);
  repository.execute(
    {
      operation: 'beginPayload',
      payload: {
        createdAt: Date.now(),
        direction: 'request',
        id: 'body',
        kind: 'text',
        ownerId: 'controlled',
        ownerKind: 'parent',
        parentId: 'controlled',
        representation: 'sanitized_text',
      },
    },
    generousBudget,
  );
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-disk-admission-'));
  databasePath = path.join(directory, 'audit.db');
  repository = new TrafficAuditRepository(databasePath);
  shutdownRepository = () => {
    repository.execute({ operation: 'shutdown', payload: null });
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  shutdownRepository();
  const resolved = path.resolve(directory);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolved).startsWith('agm-disk-admission-')
  ) {
    throw new Error('Unexpected fixture directory');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
});

describe('audit SQLite physical write admission', () => {
  it('prunes the oldest 40,000 completed application operations when the 50,000th is written', async () => {
    const seed = new Database(databasePath);
    try {
      seed.exec(`WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n<49998)
        INSERT INTO request_logs(id,timestamp,completed_at,method,url,protocol,traffic_class,request_headers,outcome)
        SELECT 'operation-' || n, (n+1)/2, n+1, 'IPC', '/ipc/test', 'ipc', 'ipc', '{}', 'completed' FROM rows;
        INSERT INTO request_logs(id,timestamp,completed_at,method,url,protocol,traffic_class,request_headers,outcome)
        VALUES ('active-operation',0,NULL,'IPC','/ipc/active','ipc','ipc','{}','in_progress'),
               ('old-model',0,1,'POST','/v1/chat/completions','openai','model','{}','completed');
        INSERT INTO audit_payloads(id,request_id,kind,representation,state,stored_bytes,chunk_count,created_at,completed_at)
        VALUES ('old-body','operation-1','text','sanitized_text','complete',1,1,1,1);
        INSERT INTO request_body_refs(request_id,direction,payload_id) VALUES ('operation-1','request','old-body');
        INSERT INTO audit_payload_chunks(payload_id,seq,payload,byte_length,encoding) VALUES ('old-body',0,x'61',1,'raw');`);
      const select = seed.prepare("SELECT COUNT(*) n FROM request_logs WHERE traffic_class='ipc'");
      const rows = () => select.get();
      const failures: unknown[] = [];
      const replies: unknown[] = [];
      const dispatch = createTrafficAuditWorkerDispatcher(
        repository,
        (result) => replies.push(result),
        (error) => failures.push(error),
      );
      shutdownRepository = () => {
        dispatch(5, { operation: 'shutdown', payload: null });
      };
      dispatch(1, { operation: 'stats', payload: null });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(rows()).toEqual({ n: 49_999 });

      const command = parent('threshold-operation');
      dispatch(2, {
        ...command,
        payload: { ...command.payload, method: 'IPC', protocol: 'ipc', trafficClass: 'ipc' },
      });
      expect(replies.at(-1)).toEqual({ id: 2, result: 1 });
      expect(rows()).toEqual({ n: 50_000 });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(rows()).toEqual({ n: 49_968 });
      dispatch(3, { operation: 'stats', payload: null });
      expect(replies.at(-1)).toMatchObject({ id: 3, result: { rows: 49_969 } });
      const arrived = parent('arrived-during-prune');
      dispatch(4, {
        ...arrived,
        payload: {
          ...arrived.payload,
          method: 'IPC',
          protocol: 'ipc',
          trafficClass: 'ipc',
          timestamp: 1,
        },
      });
      expect(replies.at(-1)).toEqual({ id: 4, result: 1 });
      seed
        .prepare(
          "UPDATE request_logs SET completed_at=2,outcome='completed' WHERE id='arrived-during-prune'",
        )
        .run();
      await vi.waitFor(
        () => {
          expect(failures).toEqual([]);
          expect(rows()).toEqual({ n: 10_001 });
        },
        { timeout: 15_000 },
      );
      expect(
        seed
          .prepare(
            "SELECT id FROM request_logs WHERE id IN ('active-operation','arrived-during-prune','old-model','threshold-operation','operation-40000','operation-40001') ORDER BY id",
          )
          .all(),
      ).toEqual([
        { id: 'active-operation' },
        { id: 'arrived-during-prune' },
        { id: 'old-model' },
        { id: 'operation-40001' },
        { id: 'threshold-operation' },
      ]);
      expect(
        seed.prepare("SELECT id FROM audit_payloads WHERE id='old-body'").get(),
      ).toBeUndefined();
      expect(seed.pragma('foreign_key_check')).toEqual([]);
    } finally {
      seed.close();
    }
  }, 20_000);

  it('reports that capture metadata could not persist while preserving the original refusal', () => {
    begin();
    expect(() =>
      repository.execute(
        {
          operation: 'appendPayloadChunk',
          payload: { payloadId: 'body', sequence: 0, data: 'denied' },
        },
        0,
      ),
    ).toThrow('audit_disk_budget; capture_metadata_unpersisted');
    expect(
      repository.execute({
        operation: 'bodyPage',
        payload: { bodyId: 'body', cursor: 0, limitBytes: 1024 },
      }),
    ).toMatchObject({ body: { state: 'writing' }, chunks: [] });
  });
  it('does not delete retained history when a reader prevents checkpoint progress', () => {
    begin();
    const reader = new Database(databasePath, { readonly: true });
    try {
      reader.exec('BEGIN');
      reader.prepare('SELECT COUNT(*) FROM request_logs').get();
      repository.execute(
        {
          operation: 'appendPayloadChunk',
          payload: { payloadId: 'body', sequence: 0, data: 'real prefix' },
        },
        generousBudget,
      );
      expect(() => repository.execute(parent('blocked'), 0)).toThrow('audit_checkpoint_busy');
      expect(repository.execute({ operation: 'stats', payload: null })).toMatchObject({ rows: 1 });
    } finally {
      reader.exec('ROLLBACK');
      reader.close();
    }
    expect(repository.execute(parent('after-reader'), generousBudget)).toBe(1);
  });

  it('refuses a read-only connection and leaves data queryable', () => {
    begin();
    const reader = new Database(databasePath, { readonly: true });
    try {
      const budget = new TrafficAuditDiskBudget(databasePath, reader);
      expect(() => budget.assertCanWrite(1, generousBudget)).toThrow('audit_read_only');
      expect(reader.prepare('SELECT COUNT(*) count FROM request_logs').get()).toEqual({ count: 1 });
    } finally {
      reader.close();
    }
  });

  it('keeps complete raw SSE with a capacity reason when reconstruction cannot reserve space', () => {
    begin();
    const text =
      'data: ' +
      JSON.stringify({
        response: {
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'x'.repeat(100000) }] },
              finishReason: 'STOP',
            },
          ],
        },
      }) +
      '\n\n';
    repository.execute(
      { operation: 'appendPayloadChunk', payload: { payloadId: 'body', sequence: 0, data: text } },
      generousBudget,
    );
    const checkpoint = new Database(databasePath);
    checkpoint.pragma('wal_checkpoint(TRUNCATE)');
    checkpoint.close();
    const used =
      fs.statSync(databasePath).size +
      (fs.existsSync(databasePath + '-wal') ? fs.statSync(databasePath + '-wal').size : 0) +
      fs.statSync(databasePath + '-shm').size;
    repository.execute(
      {
        operation: 'finalizeSsePayload',
        payload: {
          completedAt: Date.now(),
          droppedReason: null,
          errorSummary: null,
          id: 'body',
          parseErrorOffset: null,
          partial: 0,
          rawBytes: Buffer.byteLength(text),
          sanitizedBytes: Buffer.byteLength(text),
          sanitizedSha256: null,
          terminalStatus: 'completed',
        },
      },
      used + 64 * 1024,
    );
    expect(
      repository.execute({
        operation: 'bodyPage',
        payload: { bodyId: 'body', cursor: 0, limitBytes: 200000 },
      }),
    ).toMatchObject({
      body: {
        state: 'incomplete',
        representation: 'redacted_raw_sse',
        droppedReason: 'audit_disk_budget',
        partial: true,
        parseErrorOffset: null,
      },
      chunks: [{ data: text, sequence: 0 }],
    });
  });
  it('rejects a new record before persistence and permits reads and a later larger budget', () => {
    expect(() => repository.execute(parent('rejected'), 0)).toThrow('audit_disk_budget');
    expect(repository.execute({ operation: 'stats', payload: null })).toMatchObject({ rows: 0 });
    expect(repository.execute(parent('accepted'), generousBudget)).toBe(1);
    expect(repository.execute({ operation: 'stats', payload: null })).toMatchObject({ rows: 1 });
  });

  it('preserves an actual prefix as incomplete after capacity rejects the next chunk and late completion', () => {
    begin();
    repository.execute(
      {
        operation: 'appendPayloadChunk',
        payload: { payloadId: 'body', sequence: 0, data: 'real stored prefix' },
      },
      generousBudget,
    );
    const used =
      fs.statSync(databasePath).size +
      fs.statSync(databasePath + '-wal').size +
      fs.statSync(databasePath + '-shm').size;
    expect(() =>
      repository.execute(
        {
          operation: 'appendPayloadChunk',
          payload: { payloadId: 'body', sequence: 1, data: 'x'.repeat(1024 * 1024) },
        },
        used + 64 * 1024,
      ),
    ).toThrow('audit_disk_budget');
    repository.execute(
      {
        operation: 'finalizePayload',
        payload: {
          id: 'body',
          completedAt: Date.now(),
          droppedReason: null,
          errorSummary: null,
          logicalBytes: 1000000,
          oversized: 0,
          parseErrorOffset: null,
          partial: 0,
          rawBytes: 1000000,
          sha256: null,
          sha256Scope: 'full',
          state: 'complete',
          terminalStatus: 'completed',
        },
      },
      generousBudget,
    );
    expect(
      repository.execute({
        operation: 'bodyPage',
        payload: { bodyId: 'body', cursor: 0, limitBytes: 1024 },
      }),
    ).toMatchObject({
      chunks: [{ data: 'real stored prefix', sequence: 0 }],
      complete: true,
      nextCursor: null,
    });
    const detail = repository.execute({ operation: 'detail', payload: { id: 'controlled' } });
    expect(detail).toMatchObject({
      bodies: [
        expect.objectContaining({
          state: 'incomplete',
          partial: true,
          droppedReason: 'audit_disk_budget',
          storedBytes: 18,
          sha256Scope: 'stored_prefix',
        }),
      ],
    });
    repository.execute({ operation: 'shutdown', payload: null });
    repository = new TrafficAuditRepository(databasePath);
    expect(
      repository.execute({ operation: 'detail', payload: { id: 'controlled' } }),
    ).toStrictEqual(detail);
  });

  it.each(['', '-wal', '-shm'])(
    'treats a non-ENOENT stat failure as unknown, suffix=%s',
    (suffix) => {
      const real = fs.statSync;
      vi.spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike, options?: unknown) => {
        if (String(target) === databasePath + suffix) {
          throw Object.assign(new Error('controlled capacity read'), { code: 'EACCES' });
        }
        return Reflect.apply(real, fs, [target, options]);
      }) as typeof fs.statSync);
      expect(() => repository.execute(parent('unknown'), generousBudget)).toThrow(
        'audit_disk_usage_unknown',
      );
      expect(() => repository.execute({ operation: 'stats', payload: null })).toThrow();
      vi.restoreAllMocks();
      expect(repository.execute({ operation: 'stats', payload: null })).toMatchObject({ rows: 0 });
    },
  );
});
