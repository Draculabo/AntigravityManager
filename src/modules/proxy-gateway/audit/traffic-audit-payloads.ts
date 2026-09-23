import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  attemptBodyRefs,
  auditPayloads,
  requestBodyRefs,
  trafficAuditSchema,
} from './traffic-audit.schema';
import { reconstructAuditSseResponse } from './traffic-audit-sse-reconstruction';
import type { TrafficAuditWorkerCommand } from './traffic-audit.worker-protocol';

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

interface PayloadTotalsRow {
  chunkCount: number;
  storedBytes: number;
}

interface PayloadCandidateRow {
  id: string;
}

interface PayloadDedupRow {
  id: string;
  kind: string;
  logicalBytes: number;
  oversized: number;
  partial: number;
  representation: string;
  requestId: string;
  sha256: string | null;
  storedBytes: number;
}

export class TrafficAuditPayloads {
  private readonly appendPayloadChunkStatement: Database.Statement<
    [string, number, Buffer, number]
  >;

  public constructor(
    private readonly raw: Database.Database,
    private readonly orm: TrafficAuditDatabase,
  ) {
    this.appendPayloadChunkStatement = this.raw.prepare(
      "INSERT INTO audit_payload_chunks(payload_id,seq,payload,byte_length,encoding) VALUES(?,?,?,?,'raw')",
    );
  }

  public appendPayloadChunk(
    payload: Extract<TrafficAuditWorkerCommand, { operation: 'appendPayloadChunk' }>['payload'],
  ): number {
    const bytes = Buffer.from(payload.data, 'utf8');
    return this.appendPayloadChunkStatement.run(
      payload.payloadId,
      payload.sequence,
      bytes,
      bytes.byteLength,
    ).changes;
  }

  public beginPayload(payload: BeginPayload): number {
    return this.raw.transaction(() => {
      this.orm
        .insert(auditPayloads)
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
        this.orm
          .insert(requestBodyRefs)
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
        this.orm
          .insert(attemptBodyRefs)
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
    })();
  }

  public finalizePayload(payload: FinalizePayload): string {
    return this.raw.transaction(() => {
      const totals = this.raw
        .prepare<
          [string],
          PayloadTotalsRow
        >('SELECT COUNT(*) chunkCount,COALESCE(SUM(byte_length),0) storedBytes ' + 'FROM audit_payload_chunks WHERE payload_id=?')
        .get(payload.id) ?? { chunkCount: 0, storedBytes: 0 };
      this.orm
        .update(auditPayloads)
        .set({
          chunkCount: totals.chunkCount,
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
          storedBytes: totals.storedBytes,
          terminalStatus: payload.terminalStatus,
        })
        .where(eq(auditPayloads.id, payload.id))
        .run();

      if (!payload.sha256 || payload.sha256Scope !== 'full') {
        return payload.id;
      }
      const current = this.raw
        .prepare<
          [string],
          PayloadDedupRow
        >('SELECT id,request_id requestId,kind,representation,logical_bytes logicalBytes,' + 'stored_bytes storedBytes,sha256,oversized,partial FROM audit_payloads WHERE id=?')
        .get(payload.id);
      if (!current) {
        return payload.id;
      }
      const candidates = this.raw
        .prepare<
          {
            id: string;
            kind: string;
            logicalBytes: number;
            oversized: number;
            partial: number;
            representation: string;
            requestId: string;
            sha256: string;
            storedBytes: number;
          },
          PayloadCandidateRow
        >(
          "SELECT id FROM audit_payloads WHERE request_id=@requestId AND id<>@id AND state IN ('complete','incomplete') " +
            'AND representation=@representation AND kind=@kind AND logical_bytes=@logicalBytes ' +
            "AND stored_bytes=@storedBytes AND sha256=@sha256 AND sha256_scope='full' " +
            'AND oversized=@oversized AND partial=@partial ORDER BY created_at ASC',
        )
        .all({
          id: current.id,
          kind: current.kind,
          logicalBytes: current.logicalBytes,
          oversized: current.oversized,
          partial: current.partial,
          representation: current.representation,
          requestId: current.requestId,
          sha256: payload.sha256,
          storedBytes: current.storedBytes,
        });

      for (const candidate of candidates) {
        const difference = this.raw
          .prepare<
            [string, string],
            { value: number }
          >('SELECT 1 value FROM audit_payload_chunks a LEFT JOIN audit_payload_chunks b ' + 'ON b.payload_id=? AND b.seq=a.seq WHERE a.payload_id=? AND ' + '(b.seq IS NULL OR b.byte_length<>a.byte_length OR b.payload<>a.payload) LIMIT 1')
          .get(candidate.id, payload.id);
        const reverseDifference = this.raw
          .prepare<
            [string, string],
            { value: number }
          >('SELECT 1 value FROM audit_payload_chunks WHERE payload_id=? AND seq NOT IN ' + '(SELECT seq FROM audit_payload_chunks WHERE payload_id=?) LIMIT 1')
          .get(candidate.id, payload.id);
        if (!difference && !reverseDifference) {
          this.raw
            .prepare('UPDATE request_body_refs SET payload_id=? WHERE payload_id=?')
            .run(candidate.id, payload.id);
          this.raw
            .prepare('UPDATE attempt_body_refs SET payload_id=? WHERE payload_id=?')
            .run(candidate.id, payload.id);
          this.orm.delete(auditPayloads).where(eq(auditPayloads.id, payload.id)).run();
          return candidate.id;
        }
      }
      return payload.id;
    })();
  }

  public finalizeSsePayload(payload: FinalizeSsePayload): string {
    let representation = 'redacted_raw_sse';
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
        parseErrorOffset = 0;
        errorSummary =
          error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512);
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
      droppedReason: payload.droppedReason,
      errorSummary,
      id: payload.id,
      logicalBytes,
      oversized: oversized ? 1 : 0,
      parseErrorOffset,
      partial: payload.partial || oversized ? 1 : 0,
      rawBytes: payload.rawBytes,
      sha256,
      sha256Scope,
      state: payload.droppedReason ? 'incomplete' : 'complete',
      terminalStatus: payload.terminalStatus,
    });
  }

  private replacePayloadChunksFromString(id: string, value: string, maxBytes: number): void {
    this.raw.transaction(() => {
      this.raw.prepare('DELETE FROM audit_payload_chunks WHERE payload_id=?').run(id);
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
        this.appendPayloadChunkStatement.run(id, sequence, chunk, chunk.byteLength);
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
    })();
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
    const rows = this.raw
      .prepare<
        [string],
        { payload: Buffer }
      >('SELECT payload FROM audit_payload_chunks WHERE payload_id=? ORDER BY seq ASC')
      .iterate(id);
    for (const row of rows) {
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
    const rows = this.raw
      .prepare<
        [string],
        { payload: Buffer }
      >('SELECT payload FROM audit_payload_chunks WHERE payload_id=? ORDER BY seq ASC')
      .iterate(id);
    for (const row of rows) {
      hash.update(row.payload);
      bytes += row.payload.byteLength;
    }
    return { bytes, sha256: bytes > 0 ? hash.digest('hex') : null };
  }
}
