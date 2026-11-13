import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThoughtStoreRepository } from '@/modules/proxy-gateway/thought-store/thought-store.repository';
import { initializeThoughtStoreSchema } from '@/modules/proxy-gateway/thought-store/thought-store.database';
import {
  extractThoughtRecord,
  restoreStoredThoughts,
} from '@/modules/proxy-gateway/thought-store/thought-content';
import { ThoughtStoreWorkerCommandSchema } from '@/modules/proxy-gateway/thought-store/thought-store.worker-protocol';
import type { ThoughtRecord } from '@/modules/proxy-gateway/thought-store/thought-store.types';
import type { GeminiContent } from '@/modules/proxy-gateway/antigravity/types';

// This file owns isolated native persistence evidence; bypass the global empty
// native-module alias deliberately, without changing the rest of the unit suite.
vi.mock('better-sqlite3', async () => {
  const { createRequire } = await import('node:module');
  return { default: createRequire(import.meta.url)('better-sqlite3') };
});

let directory: string;
let databasePath: string;
const repositories: ThoughtStoreRepository[] = [];
const rawConnections: Database.Database[] = [];
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-thought-parts-'));
  databasePath = path.join(directory, 'thinking-store.db');
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const repository of repositories.splice(0)) {
    repository.execute({ operation: 'shutdown', payload: null });
  }
  for (const connection of rawConnections.splice(0)) {
    connection.close();
  }
  if (
    path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) ||
    !path.basename(directory).startsWith('agm-thought-parts-')
  ) {
    throw new Error('Unexpected Thought Store fixture cleanup path');
  }
  fs.rmSync(directory, { recursive: true, force: true });
});
function open() {
  const repository = new ThoughtStoreRepository(databasePath);
  repositories.push(repository);
  return repository;
}
function close(repository: ThoughtStoreRepository) {
  repository.execute({ operation: 'shutdown', payload: null });
  repositories.splice(repositories.indexOf(repository), 1);
}
function raw() {
  const database = new Database(databasePath);
  rawConnections.push(database);
  return database;
}
function oldDatabase() {
  const database = raw();
  database.pragma('journal_mode = WAL');
  database.exec(
    "CREATE TABLE thinking_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE thinking_sessions(session_key TEXT PRIMARY KEY,last_accessed INTEGER); CREATE TABLE thinking_records(id INTEGER PRIMARY KEY, session_key TEXT,signature TEXT); INSERT INTO thinking_sessions VALUES ('old',1); INSERT INTO thinking_records VALUES (1,'old','old-signature'); PRAGMA user_version=1;",
  );
  return database;
}
const model = 'gemini-pro-agent';
const parts = [
  { thought: true, text: '', thoughtSignature: 'empty' },
  { thought: true, text: 'reasoning 中😀  ', thoughtSignature: 'thinking' },
  { functionCall: { id: 'a', name: 'read', args: { path: '/a' } }, thoughtSignature: 'A' },
  {
    functionCall: { id: 'b', name: 'read', args: { path: '/b' } },
    thought_signature: 'B'.repeat(60),
  },
];
function payload() {
  const record = extractThoughtRecord({ role: 'model', parts }, model);
  if (!record) {
    throw new Error('Missing fixture record');
  }
  return {
    ...record,
    createdAt: 1,
    maxSessionBytes: 1024 * 1024,
    maxSessions: 10,
    maxTurns: 10,
    meaningful: true,
    sessionKey: 'parallel',
  };
}

describe('native Thought Store part persistence', () => {
  it.each(['skip_thought_signature_validator', 'c2tpcF90aG91Z2h0X3NpZ25hdHVyZV92YWxpZGF0b3I='])(
    'omits %s on save and historical read while preserving genuine part signatures',
    (signature) => {
      const repository = open();
      const input = { ...payload(), signature };
      const save = () =>
        repository.execute(
          ThoughtStoreWorkerCommandSchema.parse({ operation: 'save', payload: input }),
        );
      const read = () =>
        repository.execute({
          operation: 'getSession',
          payload: { sessionKey: input.sessionKey },
        });
      const database = raw();
      const stored = database.prepare('SELECT signature FROM thinking_records WHERE session_key=?');

      save();
      expect(stored.all(input.sessionKey)).toEqual([{ signature: null }]);
      database
        .prepare('UPDATE thinking_records SET signature=? WHERE session_key=?')
        .run(signature, input.sessionKey);
      const historical = read();
      expect(historical).toMatchObject([{ signature: null, partSignatures: input.partSignatures }]);
      save();
      expect(read()).toEqual(historical);
      expect(stored.all(input.sessionKey)).toEqual([{ signature: null }]);
    },
  );

  it.each(['save', 'ingestHistory'] as const)(
    'retains exact part provenance through %s, close and reopen',
    (operation) => {
      const input = payload();
      const first = open();
      first.execute(
        ThoughtStoreWorkerCommandSchema.parse({
          operation,
          payload:
            operation === 'save' ? input : { sessionKey: input.sessionKey, records: [input] },
        }),
      );
      close(first);
      const reopened = open();
      const records = reopened.execute({
        operation: 'getSession',
        payload: { sessionKey: input.sessionKey },
      }) as ThoughtRecord[];
      expect(records).toEqual([
        {
          ...extractThoughtRecord({ role: 'model', parts }, model),
          createdAt: 1,
          id: 1,
          oversized: false,
          oversizedBytes: null,
          oversizedSha256: null,
        },
      ]);
      const contents: GeminiContent[] = [
        {
          role: 'model',
          parts: [
            { thought: true, text: '...' },
            ...parts
              .filter((part) => part.functionCall)
              .map((part) => ({ functionCall: part.functionCall })),
          ],
        },
      ];
      expect(restoreStoredThoughts(contents, records, model)).toBe(1);
      expect(contents[0].parts).toEqual(
        parts.map((part) => {
          if (part.thought_signature) {
            const { thought_signature: signature, ...rest } = part;
            return { ...rest, thoughtSignature: signature };
          }
          return part;
        }),
      );
    },
  );

  it('replaces the complete version-one Thought Store and leaves adjacent feature databases untouched', () => {
    const old = oldDatabase();
    const adjacent = path.join(directory, 'accounts.db');
    fs.writeFileSync(adjacent, 'unrelated-data');
    old.close();
    rawConnections.splice(rawConnections.indexOf(old), 1);
    const repository = open();
    expect(repository.execute({ operation: 'getSession', payload: { sessionKey: 'old' } })).toEqual(
      [],
    );
    expect(raw().pragma('user_version', { simple: true })).toBe(3);
    expect(fs.readFileSync(adjacent, 'utf8')).toBe('unrelated-data');
    repository.execute({ operation: 'save', payload: payload() });
    expect(
      repository.execute({ operation: 'listRecords', payload: { sessionKey: 'parallel' } }),
    ).toHaveLength(1);
  });

  it('rolls back an interrupted replacement and permits a later explicit open', () => {
    const database = oldDatabase();
    const exec = database.exec.bind(database);
    vi.spyOn(database, 'exec').mockImplementation((sql) => {
      if (sql.includes('CREATE TABLE')) {
        throw new Error('injected replacement failure');
      }
      return exec(sql);
    });
    expect(() => initializeThoughtStoreSchema(database)).toThrow('injected replacement failure');
    expect(database.pragma('user_version', { simple: true })).toBe(1);
    expect(database.prepare('SELECT * FROM thinking_records').all()).toEqual([
      { id: 1, session_key: 'old', signature: 'old-signature' },
    ]);
    vi.restoreAllMocks();
    initializeThoughtStoreSchema(database);
    expect(database.prepare('SELECT * FROM thinking_records').all()).toEqual([]);
    expect(database.pragma('user_version', { simple: true })).toBe(3);
  });

  it('rejects a future version and another feature database without clearing either', () => {
    const database = oldDatabase();
    database.pragma('user_version=4');
    expect(() => initializeThoughtStoreSchema(database)).toThrow(
      'Unsupported Thought Store schema version: 4',
    );
    database.pragma('user_version=1');
    database.exec("CREATE TABLE accounts(id TEXT); INSERT INTO accounts VALUES ('retained');");
    expect(() => initializeThoughtStoreSchema(database)).toThrow('unowned objects');
    expect(database.prepare('SELECT * FROM accounts').all()).toEqual([{ id: 'retained' }]);
    expect(database.prepare('SELECT * FROM thinking_records').all()).toHaveLength(1);
  });

  it('counts metadata in retention and cold-load limits even when thought text is tiny', () => {
    const repository = open();
    const input = payload();
    input.thought = '';
    input.signature = null;
    input.partSignatures = input.partSignatures.filter((part) => part.kind === 'tool');
    input.maxSessionBytes = 150;
    expect(repository.execute({ operation: 'save', payload: input })).toMatchObject({
      oversized: true,
    });
    const [record] = repository.execute({
      operation: 'getSession',
      payload: { sessionKey: input.sessionKey },
    }) as ThoughtRecord[];
    expect(record).toMatchObject({
      thought: '',
      signature: null,
      partSignatures: [],
      oversized: true,
    });
    expect(
      repository.execute({
        operation: 'load',
        payload: { sessionKey: input.sessionKey, maxSessionBytes: 1 },
      }),
    ).toEqual([]);
  });
});
