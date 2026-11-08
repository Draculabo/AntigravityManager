import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initializeThoughtStoreSchema } from '@/modules/proxy-gateway/thought-store/thought-store.database';
import { ThoughtStoreRepository } from '@/modules/proxy-gateway/thought-store/thought-store.repository';
import { THOUGHT_TOOL_LINK_TTL_MS } from '@/modules/proxy-gateway/thought-store/thought-tool-links';
import { ThoughtRecordSchema } from '@/modules/proxy-gateway/thought-store/thought-owner.schema';
vi.mock('better-sqlite3', async () => {
  const { createRequire } = await import('node:module');
  return { default: createRequire(import.meta.url)('better-sqlite3') };
});
let directory: string;
let file: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-thought-round-'));
  file = path.join(directory, 'thought.db');
});
afterEach(() => {
  expect(path.dirname(path.resolve(directory))).toBe(path.resolve(os.tmpdir()));
  expect(path.basename(directory).startsWith('agm-thought-round-')).toBe(true);
  fs.rmSync(directory, { recursive: true, force: true });
});
function versionTwo() {
  const raw = new Database(file);
  raw.exec(
    'CREATE TABLE thinking_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE thinking_sessions(session_key TEXT PRIMARY KEY,last_accessed INTEGER NOT NULL,ended_at INTEGER);' +
      'CREATE TABLE thinking_records(id INTEGER PRIMARY KEY AUTOINCREMENT,session_key TEXT NOT NULL REFERENCES thinking_sessions(session_key) ON DELETE CASCADE,fingerprint TEXT NOT NULL,thought BLOB,thought_bytes INTEGER NOT NULL DEFAULT 0,signature TEXT,part_signatures TEXT NOT NULL,signature_bytes INTEGER NOT NULL,tool_ids TEXT NOT NULL,tool_names TEXT NOT NULL,primary_tool_id TEXT,visible TEXT NOT NULL,model TEXT,source_family TEXT,oversized INTEGER NOT NULL DEFAULT 0,oversized_bytes INTEGER,oversized_sha256 TEXT,created_at INTEGER NOT NULL,last_accessed INTEGER NOT NULL);' +
      "INSERT INTO thinking_meta VALUES('schema_version','2'); INSERT INTO thinking_sessions VALUES('session',100,NULL);" +
      "INSERT INTO thinking_records(session_key,fingerprint,thought,thought_bytes,signature,part_signatures,signature_bytes,tool_ids,tool_names,visible,model,source_family,created_at,last_accessed) VALUES('session','original',X'524157317361766564',5,'opaque','[]',8,'[]','[]','visible','gemini-pro','gemini',10,100); PRAGMA user_version=2;",
  );
  return raw;
}
it('preserves every schema-two row and exact blob through the additive round upgrade and reopen', () => {
  const raw = versionTwo();
  const before = z
    .object({})
    .passthrough()
    .parse(raw.prepare('SELECT * FROM thinking_records').get());
  const sessions = raw.prepare('SELECT * FROM thinking_sessions').all();
  try {
    initializeThoughtStoreSchema(raw);
    expect(raw.pragma('user_version', { simple: true })).toBe(3);
    expect(raw.prepare('SELECT * FROM thinking_records').get()).toEqual({
      ...before,
      operation_id: null,
      causal_anchor: null,
      completed_at: null,
      capture_state: 'legacy',
    });
    expect(raw.prepare('SELECT * FROM thinking_sessions').all()).toEqual(sessions);
  } finally {
    raw.close();
  }
  const repository = new ThoughtStoreRepository(file);
  try {
    expect(
      repository.execute({ operation: 'getSession', payload: { sessionKey: 'session' } }),
    ).toMatchObject([{ thought: 'saved', signature: 'opaque', createdAt: 10 }]);
  } finally {
    repository.execute({ operation: 'shutdown', payload: null });
  }
});
it('rolls back all added columns, version and rows after an interrupted additive upgrade', () => {
  const raw = versionTwo();
  const before = raw.prepare('SELECT * FROM thinking_records').all();
  const exec = raw.exec.bind(raw);
  vi.spyOn(raw, 'exec').mockImplementation((sql) => {
    if (sql.includes('CREATE INDEX')) {
      throw new Error('synthetic index failure');
    }
    return exec(sql);
  });
  try {
    expect(() => initializeThoughtStoreSchema(raw)).toThrow('synthetic index failure');
    expect(raw.pragma('user_version', { simple: true })).toBe(2);
    expect(raw.prepare('SELECT * FROM thinking_records').all()).toEqual(before);
    expect(
      raw.prepare('SELECT value FROM thinking_meta WHERE key=?').get('schema_version'),
    ).toEqual({ value: '2' });
    vi.restoreAllMocks();
    initializeThoughtStoreSchema(raw);
    expect(raw.pragma('user_version', { simple: true })).toBe(3);
  } finally {
    vi.restoreAllMocks();
    raw.close();
  }
});

it('restores a private pre-upgrade schema-two copy with every owner closed and reopens it safely', () => {
  const original = versionTwo();
  const rows = original.prepare('SELECT * FROM thinking_records').all();
  original.close();
  const backup = path.join(directory, 'private-before-upgrade.db');
  fs.copyFileSync(file, backup);
  const upgraded = new ThoughtStoreRepository(file);
  upgraded.execute({ operation: 'shutdown', payload: null });
  expect(path.dirname(path.resolve(file))).toBe(path.resolve(directory));
  expect(path.dirname(path.resolve(backup))).toBe(path.resolve(directory));
  fs.copyFileSync(backup, file);
  const restored = new Database(file);
  try {
    expect(restored.pragma('user_version', { simple: true })).toBe(2);
    expect(restored.prepare('SELECT * FROM thinking_records').all()).toEqual(rows);
  } finally {
    restored.close();
  }
  const reopened = new ThoughtStoreRepository(file);
  try {
    expect(
      reopened.execute({ operation: 'getSession', payload: { sessionKey: 'session' } }),
    ).toMatchObject([{ thought: 'saved', signature: 'opaque' }]);
  } finally {
    reopened.execute({ operation: 'shutdown', payload: null });
  }
});
it('keeps independent identical operations separate while replaying one operation idempotently', () => {
  const repository = new ThoughtStoreRepository(file);
  const record = {
    sessionKey: 'session',
    fingerprint: 'same',
    thought: 'same reasoning',
    visible: 'OK',
    signature: null,
    partSignatures: [],
    model: 'gemini-pro',
    sourceFamily: 'gemini',
    toolIds: [],
    toolNames: [],
    createdAt: 100,
    completedAt: 100,
    causalAnchor: 'a'.repeat(64),
    captureState: 'complete' as const,
    maxSessionBytes: 64 * 1024 * 1024,
    maxSessions: 2000,
    maxTurns: 600,
    meaningful: true,
  };
  try {
    repository.execute({ operation: 'save', payload: { ...record, operationId: 'first' } });
    repository.execute({ operation: 'save', payload: { ...record, operationId: 'second' } });
    repository.execute({
      operation: 'save',
      payload: { ...record, operationId: 'first', createdAt: 500, completedAt: 500 },
    });
    expect(
      repository.execute({ operation: 'getSession', payload: { sessionKey: 'session' } }),
    ).toMatchObject([
      { id: 1, operationId: 'first', thought: 'same reasoning', createdAt: 100, completedAt: 100 },
      { id: 2, operationId: 'second', thought: 'same reasoning', createdAt: 100, completedAt: 100 },
    ]);
  } finally {
    repository.execute({ operation: 'shutdown', payload: null });
  }
});

it('queries an old causal round outside the recent window without changing its completion time', () => {
  const repository = new ThoughtStoreRepository(file);
  const base = {
    sessionKey: 'session',
    fingerprint: 'same',
    thought: 'reasoning',
    visible: 'OK',
    signature: 'opaque',
    partSignatures: [],
    model: 'gemini-pro',
    sourceFamily: 'gemini',
    toolIds: [],
    toolNames: [],
    createdAt: 100,
    completedAt: 100,
    captureState: 'complete' as const,
    maxSessionBytes: 64 * 1024 * 1024,
    maxSessions: 2000,
    maxTurns: 600,
    meaningful: true,
  };
  try {
    for (let index = 0; index < 700; index += 1) {
      repository.execute({
        operation: 'save',
        payload: {
          ...base,
          operationId: `round-${index}`,
          causalAnchor: index.toString(16).padStart(64, '0'),
        },
      });
    }
    const input = { sessionKey: 'session', model: 'gemini-pro', anchors: ['0'.repeat(64)] };
    expect(repository.execute({ operation: 'findCandidates', payload: input })).toMatchObject([
      { id: 1, operationId: 'round-0', completedAt: 100 },
    ]);
    expect(
      repository.execute({
        operation: 'findCandidates',
        payload: { ...input, sessionKey: 'neighbor' },
      }),
    ).toEqual([]);
    expect(
      repository.execute({
        operation: 'findCandidates',
        payload: { ...input, model: 'claude-sonnet-4-6' },
      }),
    ).toEqual([]);
    repository.execute({
      operation: 'ingestHistory',
      payload: {
        sessionKey: 'session',
        records: [
          {
            ...base,
            causalAnchor: '0'.repeat(64),
            thought: 'reasoning enriched',
            createdAt: 900,
            completedAt: null,
            captureState: 'history',
          },
        ],
      },
    });
    expect(repository.execute({ operation: 'findCandidates', payload: input })).toMatchObject([
      {
        id: 1,
        operationId: 'round-0',
        createdAt: 100,
        completedAt: 100,
        thought: 'reasoning enriched',
      },
    ]);
    const stats = repository.execute({ operation: 'stats', payload: null });
    expect(stats).toMatchObject({ records: 700 });
  } finally {
    repository.execute({ operation: 'shutdown', payload: null });
  }
});

it('refuses an incomplete candidate set instead of treating a truncated owner as unique', () => {
  const repository = new ThoughtStoreRepository(file);
  const base = {
    sessionKey: 'session',
    fingerprint: 'same',
    thought: 'reasoning',
    visible: 'OK',
    signature: null,
    partSignatures: [],
    model: 'gemini-pro',
    sourceFamily: 'gemini',
    toolIds: [],
    toolNames: [],
    createdAt: 100,
    completedAt: 100,
    causalAnchor: 'a'.repeat(64),
    captureState: 'complete' as const,
    maxSessionBytes: 64 * 1024 * 1024,
    maxSessions: 2000,
    maxTurns: 600,
    meaningful: true,
  };
  try {
    for (let index = 0; index < 65; index += 1) {
      repository.execute({
        operation: 'save',
        payload: { ...base, operationId: `round-${index}` },
      });
    }
    expect(() =>
      repository.execute({
        operation: 'findCandidates',
        payload: { sessionKey: 'session', model: 'gemini-pro', anchors: ['a'.repeat(64)] },
      }),
    ).toThrow(/read.*budget/u);
    expect(repository.execute({ operation: 'stats', payload: null })).toMatchObject({
      records: 65,
    });
  } finally {
    repository.execute({ operation: 'shutdown', payload: null });
  }
});

it('expires tool links at original completion while retaining diagnostic signatures and exact counts', () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const repository = new ThoughtStoreRepository(file);
  const record = {
    sessionKey: 'session',
    fingerprint: 'tool',
    thought: '',
    visible: 'OK',
    signature: null,
    partSignatures: [
      {
        kind: 'tool' as const,
        position: 0,
        callId: 'a',
        name: 'read',
        argsDigest: 'b'.repeat(64),
        signature: 'opaque',
      },
    ],
    model: 'gemini-pro',
    sourceFamily: 'gemini',
    toolIds: ['a'],
    toolNames: ['read'],
    createdAt: now,
    completedAt: now,
    causalAnchor: 'a'.repeat(64),
    operationId: 'operation',
    captureState: 'complete' as const,
    maxSessionBytes: 64 * 1024 * 1024,
    maxSessions: 2000,
    maxTurns: 600,
    meaningful: true,
  };
  const input = { sessionKey: 'session', model: 'gemini-pro', anchors: ['a'.repeat(64)] };
  try {
    repository.execute({ operation: 'save', payload: record });
    expect(repository.execute({ operation: 'stats', payload: null })).toMatchObject({
      recoverableToolLinks: 1,
    });
    clock.mockReturnValue(now + THOUGHT_TOOL_LINK_TTL_MS - 1);
    expect(
      repository.execute({
        operation: 'toolRecoverySnapshot',
        payload: {
          sessionKey: 'session',
          operationIds: ['operation'],
        },
      }),
    ).toEqual([{ operationId: 'operation', positions: [0] }]);
    expect(repository.execute({ operation: 'findCandidates', payload: input })).toMatchObject([
      { partSignatures: [{ signature: 'opaque' }] },
    ]);
    clock.mockReturnValue(now + THOUGHT_TOOL_LINK_TTL_MS);
    expect(
      repository.execute({
        operation: 'toolRecoverySnapshot',
        payload: {
          sessionKey: 'session',
          operationIds: ['operation'],
        },
      }),
    ).toEqual([{ operationId: 'operation', positions: [] }]);
    expect(
      repository.execute({ operation: 'load', payload: { sessionKey: 'session' } }),
    ).toMatchObject([{ partSignatures: [{ signature: null }] }]);
    expect(repository.execute({ operation: 'findCandidates', payload: input })).toMatchObject([
      { partSignatures: [{ signature: null }] },
    ]);
    repository.execute({
      operation: 'ingestHistory',
      payload: {
        sessionKey: 'session',
        records: [
          {
            ...record,
            operationId: undefined,
            captureState: 'history',
            completedAt: null,
            createdAt: now + THOUGHT_TOOL_LINK_TTL_MS,
            thought: 'enriched diagnostic',
          },
        ],
      },
    });
    expect(repository.execute({ operation: 'stats', payload: null })).toMatchObject({
      records: 1,
      recoverableToolLinks: 0,
    });
    expect(
      repository.execute({ operation: 'getSession', payload: { sessionKey: 'session' } }),
    ).toMatchObject([{ completedAt: now, partSignatures: [{ signature: 'opaque' }] }]);
  } finally {
    repository.execute({ operation: 'shutdown', payload: null });
    clock.mockRestore();
  }
});

it('caps recoverable references at 10,000 without deleting the associated diagnostic entities', () => {
  const now = Date.now();
  const repository = new ThoughtStoreRepository(file);
  const base = {
    sessionKey: 'session',
    fingerprint: 'tool',
    thought: '',
    visible: 'OK',
    signature: null,
    model: 'gemini-pro',
    sourceFamily: 'gemini',
    toolIds: [],
    toolNames: [],
    createdAt: now,
    completedAt: now,
    captureState: 'complete' as const,
    maxSessionBytes: 64 * 1024 * 1024,
    maxSessions: 2000,
    maxTurns: 600,
    meaningful: true,
  };
  const tools = Array.from({ length: 2000 }, (_, position) => ({
    kind: 'tool' as const,
    position,
    callId: `tool-${position}`,
    name: 'read',
    argsDigest: 'b'.repeat(64),
    signature: `opaque-${position}`,
  }));
  try {
    for (let index = 0; index < 5; index += 1) {
      repository.execute({
        operation: 'save',
        payload: {
          ...base,
          operationId: `op-${index}`,
          causalAnchor: index.toString(16).padStart(64, '0'),
          partSignatures: tools,
        },
      });
    }
    repository.execute({
      operation: 'save',
      payload: {
        ...base,
        operationId: 'op-extra',
        causalAnchor: 'f'.repeat(64),
        partSignatures: [tools[0]],
      },
    });
    expect(repository.execute({ operation: 'stats', payload: null })).toMatchObject({
      records: 6,
      recoverableToolLinks: 10000,
    });
    const selected = z.array(ThoughtRecordSchema).parse(
      repository.execute({
        operation: 'findCandidates',
        payload: { sessionKey: 'session', model: 'gemini-pro', anchors: ['0'.repeat(64)] },
      }),
    );
    expect(selected).toHaveLength(1);
    expect(selected[0].partSignatures).toEqual(
      tools.map((tool, index) => (index === 0 ? { ...tool, signature: null } : tool)),
    );
    const diagnostic = ThoughtRecordSchema.parse(
      repository.execute({ operation: 'getRecord', payload: { sessionKey: 'session', id: 1 } }),
    );
    expect(diagnostic.partSignatures).toEqual(tools);
    const loaded = z
      .array(ThoughtRecordSchema)
      .parse(repository.execute({ operation: 'load', payload: { sessionKey: 'session' } }));
    expect(loaded[0].partSignatures).toEqual(selected[0].partSignatures);
    const snapshot = repository.execute({
      operation: 'toolRecoverySnapshot',
      payload: {
        sessionKey: 'session',
        operationIds: ['op-0', 'op-extra'],
      },
    });
    expect(snapshot).toEqual([
      { operationId: 'op-0', positions: Array.from({ length: 1999 }, (_, index) => index + 1) },
      { operationId: 'op-extra', positions: [0] },
    ]);
    expect(
      repository.execute({
        operation: 'toolRecoverySnapshot',
        payload: {
          sessionKey: 'neighbor',
          operationIds: ['op-0'],
        },
      }),
    ).toEqual([]);
  } finally {
    repository.execute({ operation: 'shutdown', payload: null });
  }
});
