import { createHash } from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';

import Database from 'better-sqlite3';
import { and, asc, desc, eq, exists, inArray, like, lt, notInArray, sql } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { alias } from 'drizzle-orm/sqlite-core';

import { thinkingRecords, thinkingSessions, thoughtStoreSchema } from './thought-store.schema';
import { findExistingThoughtRecordIndex, isStrongerThoughtRecord } from './thought-store.matching';
import type { ThoughtStoreWorkerCommand } from './thought-store.worker-protocol';

const RAW_MAGIC = Buffer.from('RAW1');
const GZIP_MAGIC = Buffer.from('AGZ1');
const MIN_GZIP_BYTES = 384;
const SCHEMA_VERSION = 1;

type ThoughtStoreDatabase = BetterSQLite3Database<typeof thoughtStoreSchema>;

export class ThoughtStoreRepository {
  private readonly raw: Database.Database;
  private readonly orm: ThoughtStoreDatabase;

  public constructor(private readonly databasePath: string) {
    this.raw = new Database(databasePath);
    configureThoughtStoreDatabase(this.raw);
    initializeThoughtStoreSchema(this.raw);
    this.orm = drizzle(this.raw, { schema: thoughtStoreSchema });
  }

  public execute(command: ThoughtStoreWorkerCommand): unknown {
    switch (command.operation) {
      case 'save':
        return this.save(command.payload);
      case 'ingestHistory':
        return this.ingestHistory(command.payload);
      case 'load':
      case 'getSession':
        return this.load(command.payload.sessionKey);
      case 'listSessions':
        return this.listSessions(command.payload);
      case 'listRecords':
        return this.listRecords(command.payload.sessionKey);
      case 'getRecord':
        return this.getRecord(command.payload.sessionKey, command.payload.id);
      case 'touch':
        return this.orm
          .update(thinkingSessions)
          .set({ lastAccessed: Date.now() })
          .where(eq(thinkingSessions.sessionKey, command.payload.sessionKey))
          .run().changes;
      case 'end': {
        const now = Date.now();
        return this.orm
          .update(thinkingSessions)
          .set({ endedAt: now, lastAccessed: now })
          .where(eq(thinkingSessions.sessionKey, command.payload.sessionKey))
          .run().changes;
      }
      case 'deleteSession':
        return this.orm
          .delete(thinkingSessions)
          .where(eq(thinkingSessions.sessionKey, command.payload.sessionKey))
          .run().changes;
      case 'clear':
        return this.orm.delete(thinkingSessions).run().changes;
      case 'cleanup':
        return this.cleanup(command.payload.retentionDays, command.payload.maxSessions);
      case 'stats':
        return this.stats();
      case 'shutdown':
        this.raw.pragma('wal_checkpoint(TRUNCATE)');
        this.raw.close();
        return true;
    }
  }

  private ingestHistory(
    payload: Extract<ThoughtStoreWorkerCommand, { operation: 'ingestHistory' }>['payload'],
  ): number {
    return this.raw.transaction(() => {
      const existing = this.load(payload.sessionKey);
      const used = new Set<number>();
      const upgrades: Array<{ id: number; record: (typeof payload.records)[number] }> = [];
      const toAppend: typeof payload.records = [];
      for (const record of payload.records) {
        const index = findExistingThoughtRecordIndex(record, existing, used);
        if (index === null) {
          toAppend.push(record);
          continue;
        }
        used.add(index);
        if (isStrongerThoughtRecord(record, existing[index])) {
          upgrades.push({ id: existing[index].id, record });
        }
      }
      for (const { id, record } of upgrades) {
        this.save(record, id);
      }
      for (const record of toAppend) {
        this.save(record);
      }
      return upgrades.length + toAppend.length;
    })();
  }

  private save(
    payload: Extract<ThoughtStoreWorkerCommand, { operation: 'save' }>['payload'],
    targetId?: number,
  ) {
    return this.raw.transaction(() => {
      const now = payload.createdAt || Date.now();
      this.orm
        .insert(thinkingSessions)
        .values({ endedAt: null, lastAccessed: now, sessionKey: payload.sessionKey })
        .onConflictDoUpdate({
          set: { endedAt: null, lastAccessed: now },
          target: thinkingSessions.sessionKey,
        })
        .run();

      const rawBytes = Buffer.byteLength(payload.thought, 'utf8');
      const oversized = rawBytes > payload.maxSessionBytes;
      const thought = oversized ? null : packThought(payload.thought);
      const thoughtBytes = oversized ? 0 : rawBytes;
      const oversizedSha256 = oversized
        ? createHash('sha256').update(payload.thought, 'utf8').digest('hex')
        : null;
      const primaryToolId = payload.toolIds[0] ?? null;
      const selected = this.orm
        .select({
          fingerprint: thinkingRecords.fingerprint,
          id: thinkingRecords.id,
          primaryToolId: thinkingRecords.primaryToolId,
          sessionKey: thinkingRecords.sessionKey,
          signature: thinkingRecords.signature,
          thoughtBytes: thinkingRecords.thoughtBytes,
        })
        .from(thinkingRecords)
        .where(
          targetId === undefined
            ? eq(thinkingRecords.sessionKey, payload.sessionKey)
            : eq(thinkingRecords.id, targetId),
        )
        .orderBy(desc(thinkingRecords.id))
        .limit(1)
        .get();
      if (targetId !== undefined && selected?.sessionKey !== payload.sessionKey) {
        return null;
      }
      const latest = selected;
      const matches = Boolean(
        latest &&
        (targetId !== undefined ||
          (primaryToolId
            ? latest.primaryToolId === primaryToolId
            : !latest.primaryToolId && latest.fingerprint === payload.fingerprint)),
      );

      let id: number;
      if (latest && matches) {
        const shouldReplaceThought =
          targetId !== undefined || payload.meaningful || latest.thoughtBytes <= 10;
        this.orm
          .update(thinkingRecords)
          .set({
            createdAt: now,
            lastAccessed: now,
            model: payload.model,
            primaryToolId,
            signature: payload.signature ?? latest.signature,
            sourceFamily: payload.sourceFamily,
            toolIds: JSON.stringify(payload.toolIds),
            toolNames: JSON.stringify(payload.toolNames),
            visible: payload.visible,
            ...(shouldReplaceThought
              ? {
                  oversized,
                  oversizedBytes: oversized ? rawBytes : null,
                  oversizedSha256,
                  thought,
                  thoughtBytes,
                }
              : {}),
          })
          .where(eq(thinkingRecords.id, latest.id))
          .run();
        id = latest.id;
      } else {
        const result = this.orm
          .insert(thinkingRecords)
          .values({
            createdAt: now,
            fingerprint: payload.fingerprint,
            lastAccessed: now,
            model: payload.model,
            oversized,
            oversizedBytes: oversized ? rawBytes : null,
            oversizedSha256,
            primaryToolId,
            sessionKey: payload.sessionKey,
            signature: payload.signature,
            sourceFamily: payload.sourceFamily,
            thought,
            thoughtBytes,
            toolIds: JSON.stringify(payload.toolIds),
            toolNames: JSON.stringify(payload.toolNames),
            visible: payload.visible,
          })
          .run();
        id = Number(result.lastInsertRowid);
      }

      this.pruneSession(payload.sessionKey, payload.maxTurns, payload.maxSessionBytes);
      this.pruneSessions(payload.maxSessions);
      return {
        id,
        oversized,
        oversizedBytes: oversized ? rawBytes : null,
        oversizedSha256,
      };
    })();
  }

  private load(sessionKey: string) {
    this.orm
      .update(thinkingSessions)
      .set({ lastAccessed: Date.now() })
      .where(eq(thinkingSessions.sessionKey, sessionKey))
      .run();
    return this.orm
      .select()
      .from(thinkingRecords)
      .where(eq(thinkingRecords.sessionKey, sessionKey))
      .orderBy(asc(thinkingRecords.id))
      .all()
      .map((row) => ({
        createdAt: row.createdAt,
        fingerprint: row.fingerprint,
        id: row.id,
        model: row.model,
        oversized: row.oversized,
        oversizedBytes: row.oversizedBytes,
        oversizedSha256: row.oversizedSha256,
        signature: row.signature,
        sourceFamily: row.sourceFamily,
        thought: unpackThought(row.thought),
        toolIds: parseJsonArray(row.toolIds),
        toolNames: parseJsonArray(row.toolNames),
        visible: row.visible,
      }));
  }

  private listRecords(sessionKey: string) {
    return this.orm
      .select({
        createdAt: thinkingRecords.createdAt,
        id: thinkingRecords.id,
        model: thinkingRecords.model,
        oversized: thinkingRecords.oversized,
        oversizedBytes: thinkingRecords.oversizedBytes,
        sourceFamily: thinkingRecords.sourceFamily,
        thoughtBytes: thinkingRecords.thoughtBytes,
      })
      .from(thinkingRecords)
      .where(eq(thinkingRecords.sessionKey, sessionKey))
      .orderBy(asc(thinkingRecords.id))
      .all();
  }

  private getRecord(sessionKey: string, id: number) {
    const row = this.orm.select().from(thinkingRecords).where(eq(thinkingRecords.id, id)).get();
    if (!row || row.sessionKey !== sessionKey) {
      return null;
    }
    return {
      createdAt: row.createdAt,
      fingerprint: row.fingerprint,
      id: row.id,
      model: row.model,
      oversized: row.oversized,
      oversizedBytes: row.oversizedBytes,
      oversizedSha256: row.oversizedSha256,
      signature: row.signature,
      sourceFamily: row.sourceFamily,
      thought: unpackThought(row.thought),
      toolIds: parseJsonArray(row.toolIds),
      toolNames: parseJsonArray(row.toolNames),
      visible: row.visible,
    };
  }

  private pruneSession(sessionKey: string, maxTurns: number, maxBytes: number): void {
    const rows = this.orm
      .select({ id: thinkingRecords.id, thoughtBytes: thinkingRecords.thoughtBytes })
      .from(thinkingRecords)
      .where(eq(thinkingRecords.sessionKey, sessionKey))
      .orderBy(desc(thinkingRecords.id))
      .all();
    let bytes = 0;
    const remove: number[] = [];
    for (const [index, row] of rows.entries()) {
      const next = bytes + row.thoughtBytes;
      if (index >= maxTurns || next > maxBytes) {
        remove.push(row.id);
      } else {
        bytes = next;
      }
    }
    if (remove.length > 0) {
      this.orm.delete(thinkingRecords).where(inArray(thinkingRecords.id, remove)).run();
    }
  }

  private pruneSessions(maxSessions: number): void {
    const keep = this.orm
      .select({ sessionKey: thinkingSessions.sessionKey })
      .from(thinkingSessions)
      .orderBy(desc(thinkingSessions.lastAccessed))
      .limit(maxSessions);
    this.orm.delete(thinkingSessions).where(notInArray(thinkingSessions.sessionKey, keep)).run();
  }

  private cleanup(retentionDays: number, maxSessions: number): number {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const removed = this.orm
      .delete(thinkingSessions)
      .where(lt(thinkingSessions.lastAccessed, cutoff))
      .run().changes;
    this.pruneSessions(maxSessions);
    this.raw.pragma('wal_checkpoint(PASSIVE)');
    return removed;
  }

  private listSessions(
    payload: Extract<ThoughtStoreWorkerCommand, { operation: 'listSessions' }>['payload'],
  ) {
    const search = payload.search?.trim();
    const model = payload.model?.trim();
    const matchingRecords = alias(thinkingRecords, 'matching_records');
    const matchingModel = model
      ? exists(
          this.orm
            .select({ id: matchingRecords.id })
            .from(matchingRecords)
            .where(
              and(
                eq(matchingRecords.sessionKey, thinkingSessions.sessionKey),
                like(matchingRecords.model, `%${model}%`),
              ),
            ),
        )
      : undefined;
    return this.orm
      .select({
        bytes: sql<number>`coalesce(sum(${thinkingRecords.thoughtBytes}), 0)`,
        endedAt: thinkingSessions.endedAt,
        lastAccessed: thinkingSessions.lastAccessed,
        recordCount: sql<number>`count(${thinkingRecords.id})`,
        sessionKey: thinkingSessions.sessionKey,
      })
      .from(thinkingSessions)
      .leftJoin(thinkingRecords, eq(thinkingRecords.sessionKey, thinkingSessions.sessionKey))
      .where(
        and(search ? like(thinkingSessions.sessionKey, `%${search}%`) : undefined, matchingModel),
      )
      .groupBy(thinkingSessions.sessionKey)
      .orderBy(desc(thinkingSessions.lastAccessed))
      .limit(payload.limit)
      .offset(payload.offset)
      .all();
  }

  private stats() {
    const row = this.orm
      .select({ sessions: sql<number>`count(*)` })
      .from(thinkingSessions)
      .get();
    return { databaseBytes: sqliteFilesBytes(this.databasePath), sessions: row?.sessions ?? 0 };
  }
}

function configureThoughtStoreDatabase(database: Database.Database): void {
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = NORMAL');
  database.pragma('busy_timeout = 5000');
  database.pragma('foreign_keys = ON');
  database.pragma('temp_store = MEMORY');
  database.pragma('cache_size = -64000');
}

function initializeThoughtStoreSchema(database: Database.Database): void {
  const schemaVersion = Number(database.pragma('user_version', { simple: true }));
  if (!Number.isInteger(schemaVersion) || schemaVersion > SCHEMA_VERSION) {
    throw new Error(`Unsupported Thought Store schema version: ${schemaVersion}`);
  }
  database.exec(
    'CREATE TABLE IF NOT EXISTS thinking_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS thinking_sessions (session_key TEXT PRIMARY KEY, last_accessed INTEGER NOT NULL, ended_at INTEGER);' +
      'CREATE TABLE IF NOT EXISTS thinking_records (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT NOT NULL REFERENCES thinking_sessions(session_key) ON DELETE CASCADE,' +
      'fingerprint TEXT NOT NULL, thought BLOB, thought_bytes INTEGER NOT NULL DEFAULT 0, signature TEXT,' +
      'tool_ids TEXT NOT NULL, tool_names TEXT NOT NULL, primary_tool_id TEXT, visible TEXT NOT NULL,' +
      'model TEXT, source_family TEXT, oversized INTEGER NOT NULL DEFAULT 0, oversized_bytes INTEGER,' +
      'oversized_sha256 TEXT, created_at INTEGER NOT NULL, last_accessed INTEGER NOT NULL' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_thought_sequence ON thinking_records(session_key,id ASC);' +
      'CREATE INDEX IF NOT EXISTS idx_thought_latest ON thinking_records(session_key,id DESC);' +
      'CREATE INDEX IF NOT EXISTS idx_thought_tool ON thinking_records(session_key,primary_tool_id) WHERE primary_tool_id IS NOT NULL;' +
      'CREATE INDEX IF NOT EXISTS idx_thought_fingerprint ON thinking_records(session_key,fingerprint);' +
      'CREATE INDEX IF NOT EXISTS idx_thought_accessed ON thinking_sessions(last_accessed ASC);' +
      "INSERT INTO thinking_meta(key,value) VALUES('schema_version','1') ON CONFLICT(key) DO UPDATE SET value='1';",
  );
  database.pragma(`user_version = ${SCHEMA_VERSION}`);
}

function packThought(text: string): Buffer {
  const raw = Buffer.from(text, 'utf8');
  if (raw.length >= MIN_GZIP_BYTES) {
    const compressed = zlib.gzipSync(raw, { level: zlib.constants.Z_BEST_SPEED });
    if (compressed.length + GZIP_MAGIC.length < raw.length) {
      return Buffer.concat([GZIP_MAGIC, compressed]);
    }
  }
  return Buffer.concat([RAW_MAGIC, raw]);
}

function unpackThought(value: Buffer | null): string {
  if (!value) {
    return '';
  }
  if (value.subarray(0, 4).equals(GZIP_MAGIC)) {
    try {
      return zlib.gunzipSync(value.subarray(4)).toString('utf8');
    } catch {
      return '';
    }
  }
  if (value.subarray(0, 4).equals(RAW_MAGIC)) {
    return value.subarray(4).toString('utf8');
  }
  return value.toString('utf8');
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

function sqliteFilesBytes(databasePath: string): number {
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      total += fs.statSync(`${databasePath}${suffix}`).size;
    } catch {
      // Missing sidecars are expected outside an active WAL transaction.
    }
  }
  return total;
}
