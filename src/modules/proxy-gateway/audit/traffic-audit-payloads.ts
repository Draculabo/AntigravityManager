import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type Database from 'better-sqlite3';
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNull,
  ne,
  notInArray,
  or,
  placeholder,
  sql,
  sum,
} from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { alias } from 'drizzle-orm/sqlite-core';

import { iterateSqliteQuery } from '@/shared/persistence/database/iterate-sqlite-query';
import {
  attemptBodyRefs,
  auditPayloadChunks,
  auditPayloads,
  requestBodyRefs,
  requestLogs,
  trafficAuditSchema,
  upstreamAttempts,
} from './traffic-audit.schema';
import { reconstructAuditSseResponse } from './traffic-audit-sse-reconstruction';
import type { TrafficAuditWorkerCommand } from './traffic-audit.worker-protocol';
import { toAuditDiskAdmissionError } from './traffic-audit-disk-budget';

const MAX_AUDIT_BODY_BYTES = 100 * 1024 * 1024;
type TrafficAuditDatabase = BetterSQLite3Database<typeof trafficAuditSchema>;

type BeginPayload = Extract<TrafficAuditWorkerCommand, { operation: 'beginPayload' }>['payload'];
type FinalizePayload = Extract<
  TrafficAuditWorkerCommand,
  { operation: 'finalizePayload' }
>['payload'];
type FinalizeSsePayload = Extract<
  TrafficAuditWorkerCommand,
  { operation: 'finalizeSsePayload' }
>['payload'];

export class TrafficAuditPayloads {
  private readonly appendPayloadChunkStatement;

  public constructor(
    private readonly raw: Database.Database,
    private readonly orm: TrafficAuditDatabase,
    private readonly admitReplacement: (bytes: number) => void,
  ) {
    this.appendPayloadChunkStatement = this.orm
      .insert(auditPayloadChunks)
      .select(
        this.orm
          .select({
            payloadId: auditPayloads.id,
            sequence: sql<number>`${placeholder('sequence')}`.as('seq'),
            payload: sql<Buffer>`${placeholder('payload')}`.as('payload'),
            byteLength: sql<number>`${placeholder('byteLength')}`.as('byte_length'),
            encoding: sql<string>`${'raw'}`.as('encoding'),
          })
          .from(auditPayloads)
          .where(
            and(eq(auditPayloads.id, placeholder('payloadId')), eq(auditPayloads.state, 'writing')),
          ),
      )
      .prepare();
  }

  public appendPayloadChunk(
    payload: Extract<TrafficAuditWorkerCommand, { operation: 'appendPayloadChunk' }>['payload'],
  ): number {
    return this.appendChunk(payload.payloadId, payload.sequence, Buffer.from(payload.data, 'utf8'));
  }

  private appendChunk(payloadId: string, sequence: number, payload: Buffer): number {
    return this.appendPayloadChunkStatement.run({
      payloadId,
      sequence,
      payload,
      byteLength: payload.byteLength,
    }).changes;
  }

  public markIncomplete(id: string, reason: string): void {
    if (!this.isWriting(id)) {
      return;
    }
    const stored = this.hashStoredPayload(id);
    this.orm
      .update(auditPayloads)
      .set({
        state: 'incomplete',
        partial: true,
        droppedReason: reason,
        storedBytes: stored.bytes,
        chunkCount: this.orm.$count(auditPayloadChunks, eq(auditPayloadChunks.payloadId, id)),
        completedAt: Date.now(),
        logicalBytes: sql`max(${auditPayloads.logicalBytes}, ${stored.bytes})`,
        sha256: stored.sha256,
        sha256Scope: stored.bytes > 0 ? 'stored_prefix' : 'unavailable',
      })
      .where(and(eq(auditPayloads.id, id), eq(auditPayloads.state, 'writing')))
      .run();
  }

  public beginPayload(payload: BeginPayload): number {
    return this.orm.transaction((tx) => {
      const exists =
        payload.ownerKind === 'parent'
          ? payload.ownerId === payload.parentId &&
            tx
              .select({ id: requestLogs.id })
              .from(requestLogs)
              .where(eq(requestLogs.id, payload.parentId))
              .get()
          : tx
              .select({ id: upstreamAttempts.id })
              .from(upstreamAttempts)
              .where(
                and(
                  eq(upstreamAttempts.id, payload.ownerId),
                  eq(upstreamAttempts.parentId, payload.parentId),
                ),
              )
              .get();
      if (!exists) {
        return 0;
      }
      tx.insert(auditPayloads)
        .values({
          createdAt: payload.createdAt,
          id: payload.id,
          kind: payload.kind,
          representation: payload.representation,
          requestId: payload.parentId,
          state: 'writing',
        })
        .run();
      if (payload.ownerKind === 'parent') {
        tx.insert(requestBodyRefs)
          .values({
            direction: payload.direction,
            payloadId: payload.id,
            requestId: payload.ownerId,
          })
          .onConflictDoUpdate({
            set: { payloadId: payload.id },
            target: [requestBodyRefs.requestId, requestBodyRefs.direction],
          })
          .run();
      } else {
        tx.insert(attemptBodyRefs)
          .values({
            attemptId: payload.ownerId,
            direction: payload.direction,
            payloadId: payload.id,
          })
          .onConflictDoUpdate({
            set: { payloadId: payload.id },
            target: [attemptBodyRefs.attemptId, attemptBodyRefs.direction],
          })
          .run();
      }
      return 1;
    });
  }

  public finalizePayload(payload: FinalizePayload): string {
    return this.orm.transaction((tx) => {
      if (!this.isWriting(payload.id)) {
        return payload.id;
      }
      const totals = tx
        .select({
          chunkCount: count(),
          storedBytes: sum(auditPayloadChunks.byteLength).mapWith(Number),
        })
        .from(auditPayloadChunks)
        .where(eq(auditPayloadChunks.payloadId, payload.id))
        .get();
      tx.update(auditPayloads)
        .set({
          chunkCount: totals?.chunkCount ?? 0,
          completedAt: payload.completedAt,
          droppedReason: payload.droppedReason,
          errorSummary: payload.errorSummary,
          logicalBytes: payload.logicalBytes,
          oversized: Boolean(payload.oversized),
          parseErrorOffset: payload.parseErrorOffset,
          partial: Boolean(payload.partial),
          rawBytes: payload.rawBytes,
          sha256: payload.sha256,
          sha256Scope: payload.sha256Scope,
          state: payload.state,
          storedBytes: totals?.storedBytes ?? 0,
          terminalStatus: payload.terminalStatus,
        })
        .where(eq(auditPayloads.id, payload.id))
        .run();

      if (!payload.sha256 || payload.sha256Scope !== 'full') {
        return payload.id;
      }
      const current = tx
        .select({
          id: auditPayloads.id,
          kind: auditPayloads.kind,
          logicalBytes: auditPayloads.logicalBytes,
          oversized: auditPayloads.oversized,
          partial: auditPayloads.partial,
          representation: auditPayloads.representation,
          requestId: auditPayloads.requestId,
          storedBytes: auditPayloads.storedBytes,
        })
        .from(auditPayloads)
        .where(eq(auditPayloads.id, payload.id))
        .get();
      if (!current) {
        return payload.id;
      }
      const candidates = tx
        .select({ id: auditPayloads.id })
        .from(auditPayloads)
        .where(
          and(
            eq(auditPayloads.requestId, current.requestId),
            ne(auditPayloads.id, current.id),
            inArray(auditPayloads.state, ['complete', 'incomplete']),
            eq(auditPayloads.representation, current.representation),
            eq(auditPayloads.kind, current.kind),
            eq(auditPayloads.logicalBytes, current.logicalBytes),
            eq(auditPayloads.storedBytes, current.storedBytes),
            eq(auditPayloads.sha256, payload.sha256),
            eq(auditPayloads.sha256Scope, 'full'),
            eq(auditPayloads.oversized, current.oversized),
            eq(auditPayloads.partial, current.partial),
          ),
        )
        .orderBy(asc(auditPayloads.createdAt))
        .all();

      const matchingChunks = alias(auditPayloadChunks, 'matching_chunks');
      for (const candidate of candidates) {
        const difference = tx
          .select({ sequence: auditPayloadChunks.sequence })
          .from(auditPayloadChunks)
          .leftJoin(
            matchingChunks,
            and(
              eq(matchingChunks.payloadId, candidate.id),
              eq(matchingChunks.sequence, auditPayloadChunks.sequence),
            ),
          )
          .where(
            and(
              eq(auditPayloadChunks.payloadId, payload.id),
              or(
                isNull(matchingChunks.sequence),
                ne(matchingChunks.byteLength, auditPayloadChunks.byteLength),
                ne(matchingChunks.payload, auditPayloadChunks.payload),
              ),
            ),
          )
          .limit(1)
          .get();
        const reverseDifference = tx
          .select({ sequence: auditPayloadChunks.sequence })
          .from(auditPayloadChunks)
          .where(
            and(
              eq(auditPayloadChunks.payloadId, candidate.id),
              notInArray(
                auditPayloadChunks.sequence,
                tx
                  .select({ sequence: matchingChunks.sequence })
                  .from(matchingChunks)
                  .where(eq(matchingChunks.payloadId, payload.id)),
              ),
            ),
          )
          .limit(1)
          .get();
        if (!difference && !reverseDifference) {
          tx.update(requestBodyRefs)
            .set({ payloadId: candidate.id })
            .where(eq(requestBodyRefs.payloadId, payload.id))
            .run();
          tx.update(attemptBodyRefs)
            .set({ payloadId: candidate.id })
            .where(eq(attemptBodyRefs.payloadId, payload.id))
            .run();
          tx.delete(auditPayloads).where(eq(auditPayloads.id, payload.id)).run();
          return candidate.id;
        }
      }
      return payload.id;
    });
  }

  public finalizeSsePayload(payload: FinalizeSsePayload): string {
    if (!this.isWriting(payload.id)) {
      return payload.id;
    }
    let representation = 'redacted_raw_sse';
    let droppedReason = payload.droppedReason;
    let parseErrorOffset = payload.parseErrorOffset;
    let errorSummary = payload.errorSummary;
    let logicalBytes = payload.sanitizedBytes;
    let oversized = logicalBytes > MAX_AUDIT_BODY_BYTES;
    let sha256: string | null = null;
    let sha256Scope = 'unavailable';

    if (parseErrorOffset === null && !oversized && !payload.droppedReason) {
      try {
        const events = this.parseSsePayload(payload.id);
        const output = JSON.stringify({
          response: reconstructAuditSseResponse(events),
          stream: true,
        });
        logicalBytes = Buffer.byteLength(output, 'utf8');
        oversized = logicalBytes > MAX_AUDIT_BODY_BYTES;
        sha256 = createHash('sha256').update(output, 'utf8').digest('hex');
        sha256Scope = 'full';
        this.replacePayloadChunksFromString(payload.id, output, MAX_AUDIT_BODY_BYTES);
        representation = 'reconstructed_sse';
      } catch (error) {
        const storageFailure = toAuditDiskAdmissionError(error);
        if (storageFailure) {
          droppedReason = storageFailure.reason;
        } else {
          parseErrorOffset = 0;
        }
        errorSummary =
          storageFailure?.message ??
          (error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512));
      }
    }

    if (representation === 'redacted_raw_sse') {
      const stored = this.hashStoredPayload(payload.id);
      logicalBytes = Math.max(payload.sanitizedBytes, stored.bytes);
      oversized = logicalBytes > MAX_AUDIT_BODY_BYTES;
      sha256 = payload.sanitizedSha256 || stored.sha256;
      sha256Scope = payload.sanitizedSha256
        ? 'full'
        : logicalBytes === stored.bytes
          ? 'full'
          : 'stored_prefix';
      if (oversized && !errorSummary) {
        errorSummary =
          'SSE reconstruction skipped because the sanitized body exceeds the 100 MiB storage cap';
      }
    }

    this.orm
      .update(auditPayloads)
      .set({ representation })
      .where(eq(auditPayloads.id, payload.id))
      .run();
    return this.finalizePayload({
      completedAt: payload.completedAt,
      droppedReason,
      errorSummary,
      id: payload.id,
      logicalBytes,
      oversized: oversized ? 1 : 0,
      parseErrorOffset,
      partial: payload.partial || oversized || droppedReason ? 1 : 0,
      rawBytes: payload.rawBytes,
      sha256,
      sha256Scope,
      state: droppedReason ? 'incomplete' : 'complete',
      terminalStatus: payload.terminalStatus,
    });
  }

  private isWriting(id: string): boolean {
    return Boolean(
      this.orm
        .select({ id: auditPayloads.id })
        .from(auditPayloads)
        .where(and(eq(auditPayloads.id, id), eq(auditPayloads.state, 'writing')))
        .get(),
    );
  }

  private replacePayloadChunksFromString(id: string, value: string, maxBytes: number): void {
    this.admitReplacement(Math.min(Buffer.byteLength(value, 'utf8'), maxBytes));
    this.orm.transaction((tx) => {
      tx.delete(auditPayloadChunks).where(eq(auditPayloadChunks.payloadId, id)).run();
      let bufferedBytes = 0;
      let sourceOffset = 0;
      let storedBytes = 0;
      let sequence = 0;
      const parts: Buffer[] = [];
      const flush = () => {
        if (bufferedBytes === 0) {
          return;
        }
        const chunk = Buffer.concat(parts, bufferedBytes);
        this.appendChunk(id, sequence, chunk);
        parts.length = 0;
        bufferedBytes = 0;
        storedBytes += chunk.byteLength;
        sequence += 1;
      };
      while (sourceOffset < value.length && storedBytes + bufferedBytes < maxBytes) {
        let sourceEnd = Math.min(sourceOffset + 16 * 1024, value.length);
        if (sourceEnd < value.length) {
          const lastCode = value.charCodeAt(sourceEnd - 1);
          if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
            sourceEnd -= 1;
          }
        }
        const bytes = Buffer.from(value.slice(sourceOffset, sourceEnd), 'utf8');
        sourceOffset = sourceEnd;
        let byteOffset = 0;
        while (byteOffset < bytes.byteLength && storedBytes + bufferedBytes < maxBytes) {
          let take = Math.min(
            64 * 1024 - bufferedBytes,
            maxBytes - storedBytes - bufferedBytes,
            bytes.byteLength - byteOffset,
          );
          if (byteOffset + take < bytes.byteLength) {
            while (take > 0 && (bytes[byteOffset + take] & 0xc0) === 0x80) {
              take -= 1;
            }
          }
          if (take === 0) {
            if (bufferedBytes === 0) {
              sourceOffset = value.length;
              break;
            }
            flush();
            continue;
          }
          parts.push(bytes.subarray(byteOffset, byteOffset + take));
          bufferedBytes += take;
          byteOffset += take;
          if (bufferedBytes === 64 * 1024) {
            flush();
          }
        }
      }
      flush();
    });
  }

  private iterateChunks(id: string): IterableIterator<{ payload: Buffer }> {
    return iterateSqliteQuery(
      this.raw,
      this.orm
        .select({ payload: auditPayloadChunks.payload })
        .from(auditPayloadChunks)
        .where(eq(auditPayloadChunks.payloadId, id))
        .orderBy(asc(auditPayloadChunks.sequence)),
    );
  }

  private parseSsePayload(id: string): unknown[] {
    const events: unknown[] = [];
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let dataLines: string[] = [];
    const consumeLine = (line: string) => {
      if (line === '') {
        const data = dataLines.join('\n');
        dataLines = [];
        if (data && data.trim() !== '[DONE]') {
          events.push(JSON.parse(data));
        }
        return;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /u, ''));
      }
    };
    const consumeText = (text: string) => {
      pending += text;
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        consumeLine(line);
      }
    };
    for (const row of this.iterateChunks(id)) {
      consumeText(decoder.write(row.payload));
    }
    consumeText(decoder.end());
    if (pending) {
      consumeLine(pending);
    }
    if (dataLines.length > 0) {
      consumeLine('');
    }
    return events;
  }

  private hashStoredPayload(id: string): { bytes: number; sha256: string | null } {
    const hash = createHash('sha256');
    let bytes = 0;
    for (const row of this.iterateChunks(id)) {
      hash.update(row.payload);
      bytes += row.payload.byteLength;
    }
    return { bytes, sha256: bytes > 0 ? hash.digest('hex') : null };
  }
}
