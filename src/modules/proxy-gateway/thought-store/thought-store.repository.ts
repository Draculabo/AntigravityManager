import { createHash } from 'node:crypto';

import Database from 'better-sqlite3';
import { and, desc, eq, exists, like, sql } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { alias } from 'drizzle-orm/sqlite-core';

import { thinkingRecords, thinkingSessions, thoughtStoreSchema } from './thought-store.schema';
import {
  findExistingThoughtRecordIndex,
  isStrongerThoughtRecord,
  thoughtRecordsConflict,
} from './thought-store.matching';
import type { ThoughtStoreWorkerCommand } from './thought-store.worker-protocol';
import { areThoughtRecordModelsCompatible } from './thought-store.model';
import { packThought, unpackThought } from './thought-store.blob';
import { initializeThoughtStoreSchema } from './thought-store.database';
import { decodeThoughtPartSignatures, thoughtPartsBytes } from './thought-part-signatures';
import { omitThoughtSignaturePlaceholder } from '../antigravity/ThoughtSignatureCompat';
import { mergeThoughtRecordContent } from './thought-record-content';
import { parsePartSignatures, parseThoughtToolList } from './thought-store.codec';
import { ThoughtStoreReads } from './thought-store-reads';
import {
  SqliteWriteBudget,
  sqliteFilesBytes,
} from '@/shared/persistence/database/sqlite-write-budget';
import { ThoughtStoreMaintenance } from './thought-store-maintenance';
import { mergeThoughtProvenance } from './thought-record-provenance';
import { queryThoughtCandidates } from './thought-candidate-query';
import { ThoughtReadBudgetError } from './thought-read-budget';
import { ThoughtToolLinks } from './thought-tool-links';

type ThoughtStoreDatabase = BetterSQLite3Database<typeof thoughtStoreSchema>;
const MAX_THOUGHT_MATCH_CANDIDATES = 200;

export class ThoughtStoreRepository {
  private readonly raw: Database.Database;
  private readonly orm: ThoughtStoreDatabase;
  private readonly reads: ThoughtStoreReads;
  private readonly diskBudget: SqliteWriteBudget;
  private readonly maintenance: ThoughtStoreMaintenance;
  private readonly toolLinks: ThoughtToolLinks;

  public constructor(private readonly databasePath: string) {
    this.raw = new Database(databasePath);
    try {
      configureThoughtStoreDatabase(this.raw);
      initializeThoughtStoreSchema(this.raw);
      this.orm = drizzle(this.raw, { schema: thoughtStoreSchema });
      this.reads = new ThoughtStoreReads(this.orm);
      this.diskBudget = new SqliteWriteBudget(databasePath, this.raw);
      this.maintenance = new ThoughtStoreMaintenance(this.raw, databasePath);
      this.toolLinks = new ThoughtToolLinks(this.raw);
    } catch (error) {
      this.raw.close();
      throw error;
    }
  }

  public execute(command: ThoughtStoreWorkerCommand): unknown {
    switch (command.operation) {
      case 'save':
        this.diskBudget.assertCanWrite(
          Buffer.byteLength(JSON.stringify(command.payload), 'utf8'),
          command.payload.maxDiskBytes ?? 1024 * 1024 * 1024,
        );
        return this.save(command.payload);
      case 'ingestHistory':
        this.diskBudget.assertCanWrite(
          Buffer.byteLength(JSON.stringify(command.payload), 'utf8'),
          command.payload.records[0]?.maxDiskBytes ?? 1024 * 1024 * 1024,
        );
        return this.ingestHistory(command.payload);
      case 'load':
        return this.toolLinks.recoverable(
          command.payload.sessionKey,
          this.reads.load(command.payload.sessionKey, command.payload),
        );
      case 'getSession':
        return this.reads.load(command.payload.sessionKey);
      case 'listSessions':
        return this.listSessions(command.payload);
      case 'listRecords':
        return this.reads.listRecords(command.payload.sessionKey);
      case 'listRecordPage':
        return this.reads.listRecordPage(command.payload);
      case 'findCandidates':
        return this.toolLinks.recoverable(
          command.payload.sessionKey,
          queryThoughtCandidates(this.orm, this.reads, command.payload),
        );
      case 'toolRecoverySnapshot':
        return this.toolLinks.snapshot(command.payload.sessionKey, command.payload.operationIds, command.payload.layouts);
      case 'getRecord':
        return this.reads.getRecord(command.payload.sessionKey, command.payload.id);
      case 'touch':
        this.diskBudget.assertCanWrite(
          256,
          command.payload.maxDiskBytes ?? 1024 * 1024 * 1024,
          false,
        );
        return this.orm
          .update(thinkingSessions)
          .set({ lastAccessed: Date.now() })
          .where(eq(thinkingSessions.sessionKey, command.payload.sessionKey))
          .run().changes;
      case 'end': {
        this.diskBudget.assertCanWrite(
          256,
          command.payload.maxDiskBytes ?? 1024 * 1024 * 1024,
          false,
        );
        const now = Date.now();
        return this.raw.transaction(() => {
          const records = this.recordCount(command.payload.sessionKey);
          const sessions = this.orm
            .update(thinkingSessions)
            .set({ endedAt: now, lastAccessed: now })
            .where(eq(thinkingSessions.sessionKey, command.payload.sessionKey))
            .run().changes;
          return { sessions, records };
        })();
      }
      case 'deleteSession':
        return this.raw.transaction(() => {
          const records = this.recordCount(command.payload.sessionKey);
          const sessions = this.orm
            .delete(thinkingSessions)
            .where(eq(thinkingSessions.sessionKey, command.payload.sessionKey))
            .run().changes;
          return { sessions, records };
        })();
      case 'clear':
        return this.raw.transaction(() => {
          const records = this.recordCount();
          const sessions = this.orm.delete(thinkingSessions).run().changes;
          return { sessions, records };
        })();
      case 'cleanup':
        return this.maintenance.run(command.payload);
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
      const anchors = [
        ...new Set(
          payload.records.flatMap((record) => (record.causalAnchor ? [record.causalAnchor] : [])),
        ),
      ];
      if (anchors.length > 64) {
        throw new ThoughtReadBudgetError();
      }
      const targeted = anchors.length
        ? queryThoughtCandidates(this.orm, this.reads, {
            sessionKey: payload.sessionKey,
            model: payload.records[0]?.model ?? '',
            anchors,
          })
        : [];
      const recent = payload.records.some((record) => !record.causalAnchor)
        ? this.reads.load(payload.sessionKey, {
            maxTurns: MAX_THOUGHT_MATCH_CANDIDATES,
          })
        : [];
      const existing = [
        ...targeted,
        ...recent.filter((record) => !targeted.some((candidate) => candidate.id === record.id)),
      ];
      const used = new Set<number>();
      const upgrades: Array<{ id: number; record: (typeof payload.records)[number] }> = [];
      const toAppend: typeof payload.records = [];
      for (const record of payload.records) {
        const index = findExistingThoughtRecordIndex(record, existing, used);
        if (index === null) {
          if (!record.causalAnchor || record.captureState !== 'history') {
            toAppend.push(record);
          }
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
      const known = this.orm
        .select({ sessionKey: thinkingSessions.sessionKey })
        .from(thinkingSessions)
        .where(eq(thinkingSessions.sessionKey, payload.sessionKey))
        .get();
      const count =
        this.orm
          .select({ count: sql<number>`count(*)` })
          .from(thinkingSessions)
          .get()?.count ?? 0;
      if (!known && count >= payload.maxSessions) {
        throw new Error('Thought Store write rejected: session_capacity');
      }
      this.orm
        .insert(thinkingSessions)
        .values({ endedAt: null, lastAccessed: now, sessionKey: payload.sessionKey })
        .onConflictDoUpdate({
          set: { endedAt: null, lastAccessed: now },
          target: thinkingSessions.sessionKey,
        })
        .run();

      decodeThoughtPartSignatures(payload.partSignatures, payload.thought);
      const primaryToolId = payload.toolIds[0] ?? null;
      const operationMatches = payload.operationId
        ? this.orm
            .select({ id: thinkingRecords.id })
            .from(thinkingRecords)
            .where(
              and(
                eq(thinkingRecords.sessionKey, payload.sessionKey),
                eq(thinkingRecords.operationId, payload.operationId),
              ),
            )
            .limit(2)
            .all()
        : [];
      if (operationMatches.length > 1) {
        throw new Error('Thought Store operation ownership is ambiguous');
      }
      const selectedId = targetId ?? operationMatches[0]?.id;
      const newOperation = payload.operationId && selectedId === undefined;
      if (!newOperation) {
        this.reads.assertMatchBudget(payload.sessionKey, selectedId, MAX_THOUGHT_MATCH_CANDIDATES);
      }
      const selected = newOperation
        ? []
        : this.orm
            .select({
              operationId: thinkingRecords.operationId,
              causalAnchor: thinkingRecords.causalAnchor,
              captureState: thinkingRecords.captureState,
              completedAt: thinkingRecords.completedAt,
              createdAt: thinkingRecords.createdAt,
              fingerprint: thinkingRecords.fingerprint,
              id: thinkingRecords.id,
              model: thinkingRecords.model,
              primaryToolId: thinkingRecords.primaryToolId,
              sessionKey: thinkingRecords.sessionKey,
              signature: thinkingRecords.signature,
              partSignatures: thinkingRecords.partSignatures,
              thoughtBytes: thinkingRecords.thoughtBytes,
              toolIds: thinkingRecords.toolIds,
              toolNames: thinkingRecords.toolNames,
              visible: thinkingRecords.visible,
            })
            .from(thinkingRecords)
            .where(
              selectedId === undefined
                ? eq(thinkingRecords.sessionKey, payload.sessionKey)
                : eq(thinkingRecords.id, selectedId),
            )
            .orderBy(desc(thinkingRecords.id))
            .limit(selectedId === undefined ? MAX_THOUGHT_MATCH_CANDIDATES : 1)
            .all()
            .map((row) => ({
              ...row,
              signature: omitThoughtSignaturePlaceholder(row.signature),
              partSignatures: parsePartSignatures(row.partSignatures),
              toolIds: parseThoughtToolList(row.toolIds),
              toolNames: parseThoughtToolList(row.toolNames),
            }));
      if (targetId !== undefined && selected[0]?.sessionKey !== payload.sessionKey) {
        return null;
      }
      const matchedIndex = findExistingThoughtRecordIndex(payload, selected, new Set());
      const latest =
        targetId !== undefined
          ? selected[0]
          : matchedIndex === null
            ? undefined
            : selected[matchedIndex];
      const matches = Boolean(
        latest &&
        areThoughtRecordModelsCompatible(latest, payload) &&
        !thoughtRecordsConflict(latest, payload) &&
        (targetId !== undefined || matchedIndex !== null),
      );
      if (payload.operationId && operationMatches.length > 0 && !matches) {
        throw new Error('Thought Store operation ownership mismatch');
      }

      const previous =
        latest && matches
          ? this.orm
              .select({ thought: thinkingRecords.thought })
              .from(thinkingRecords)
              .where(eq(thinkingRecords.id, latest.id))
              .get()
          : null;
      const content =
        latest && previous
          ? mergeThoughtRecordContent(payload, {
              ...latest,
              thought: unpackThought(previous.thought, latest.id),
            })
          : payload;
      const rawBytes =
        Buffer.byteLength(content.thought, 'utf8') +
        thoughtPartsBytes(content.partSignatures) +
        Buffer.byteLength(content.signature ?? '', 'utf8');
      const oversized = rawBytes > payload.maxSessionBytes;
      const signature = oversized ? null : content.signature;
      const partSignatures = JSON.stringify(oversized ? [] : content.partSignatures);
      const stored = {
        ...(latest && matches
          ? mergeThoughtProvenance(payload, latest)
          : {
              operationId: payload.operationId ?? null,
              causalAnchor: payload.causalAnchor ?? null,
              completedAt: payload.completedAt ?? null,
              captureState: payload.captureState ?? 'legacy',
            }),
        signature,
        partSignatures,
        signatureBytes:
          Buffer.byteLength(partSignatures, 'utf8') + Buffer.byteLength(signature ?? '', 'utf8'),
        oversized,
        oversizedBytes: oversized ? rawBytes : null,
        oversizedSha256: oversized
          ? createHash('sha256').update(content.thought, 'utf8').digest('hex')
          : null,
        thought: oversized ? null : packThought(content.thought),
        thoughtBytes: oversized ? 0 : Buffer.byteLength(content.thought, 'utf8'),
      };
      let id: number;
      if (latest && matches) {
        this.orm
          .update(thinkingRecords)
          .set({
            createdAt: latest.createdAt,
            fingerprint: payload.fingerprint,
            lastAccessed: now,
            model: payload.model,
            primaryToolId,
            sourceFamily: payload.sourceFamily,
            toolIds: JSON.stringify(payload.toolIds),
            toolNames: JSON.stringify(payload.toolNames),
            visible: payload.visible,
            ...stored,
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
            primaryToolId,
            sessionKey: payload.sessionKey,
            sourceFamily: payload.sourceFamily,
            ...stored,
            toolIds: JSON.stringify(payload.toolIds),
            toolNames: JSON.stringify(payload.toolNames),
            visible: payload.visible,
          })
          .run();
        id = Number(result.lastInsertRowid);
      }

      this.toolLinks.save(
        id,
        {
          ...payload,
          ...content,
          operationId: stored.operationId,
          causalAnchor: stored.causalAnchor,
          completedAt: stored.completedAt,
          captureState: stored.captureState,
          partSignatures: oversized ? [] : content.partSignatures,
        },
        latest && matches ? latest.partSignatures : undefined,
      );
      return {
        id,
        oversized,
        oversizedBytes: oversized ? rawBytes : null,
        oversizedSha256: stored.oversizedSha256,
      };
    })();
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
        bytes: sql<number>`coalesce(sum(${thinkingRecords.thoughtBytes} + ${thinkingRecords.signatureBytes}), 0)`,
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
    const records =
      this.orm
        .select({ count: sql<number>`count(*)` })
        .from(thinkingRecords)
        .get()?.count ?? 0;
    return {
      databaseBytes: sqliteFilesBytes(this.databasePath),
      sessions: row?.sessions ?? 0,
      records,
      recoverableToolLinks: this.toolLinks.count(),
    };
  }

  private recordCount(sessionKey?: string): number {
    return (
      this.orm
        .select({ count: sql<number>`count(*)` })
        .from(thinkingRecords)
        .where(sessionKey === undefined ? undefined : eq(thinkingRecords.sessionKey, sessionKey))
        .get()?.count ?? 0
    );
  }
}

function configureThoughtStoreDatabase(database: Database.Database): void {
  if (Number(database.pragma('page_count', { simple: true })) === 0) {
    database.pragma('auto_vacuum = INCREMENTAL');
  }
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = NORMAL');
  database.pragma('busy_timeout = 5000');
  database.pragma('foreign_keys = ON');
  database.pragma('temp_store = MEMORY');
  database.pragma('cache_size = -64000');
}
