import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import {
  SqliteDiskAdmissionError,
  SqliteWriteBudget,
  sqliteFilesBytes,
} from '@/shared/persistence/database/sqlite-write-budget';
import { decodeErrorRecord, MAX_ERROR_RECORD_BYTES } from './error-record';
import { initializeErrorWindow, type ErrorDiagnosticRole } from './error-window.database';
import {
  ErrorAllocationSchema,
  ErrorWindowMetadataSchema,
  ErrorWindowPageSchema,
  type ErrorWindowCommand,
} from './error-window.schema';

const CountSchema = z.object({ count: z.number().int().safe().nonnegative() });
const BytesSchema = z.object({ bytes: z.number().int().safe().nonnegative() });
const HighWaterSchema = z.object({ sequence: z.number().int().safe().nonnegative() });
const MAX_PAGE_BYTES = 512 * 1024;

function isLinkedFile(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/** One role owns this connection. Its allocation is supplied by deployment configuration. */
export class ErrorWindowRepository {
  private readonly raw: Database.Database;
  private readonly disk: SqliteWriteBudget;
  private generation: string | null = null;
  private allocationBytes = 0;
  private maintenanceCeiling = 0;
  private reclaiming = false;

  constructor(
    private readonly databasePath: string,
    private readonly role: ErrorDiagnosticRole,
  ) {
    if (
      fs.lstatSync(path.dirname(databasePath)).isSymbolicLink() ||
      ['', '-wal', '-shm'].some((suffix) => isLinkedFile(databasePath + suffix))
    ) {
      throw new Error('Local error diagnostic storage must not be a symbolic link');
    }
    this.raw = new Database(databasePath);
    try {
      initializeErrorWindow(this.raw, role);
      this.disk = new SqliteWriteBudget(databasePath, this.raw);
    } catch (error) {
      this.raw.close();
      throw error;
    }
  }

  execute(command: ErrorWindowCommand): unknown {
    if (command.operation === 'shutdown') {
      this.raw.close();
      return null;
    }
    if (command.operation === 'initialize') {
      if (this.generation !== null) {
        throw new Error('Local error diagnostic owner is already initialized');
      }
      this.generation = command.payload.generation;
      this.allocationBytes = command.payload.allocationBytes;
      const storedCeiling = this.raw
        .prepare("SELECT value FROM error_window_meta WHERE key='maintenance_ceiling'")
        .get();
      const previousCeiling = storedCeiling
        ? z
            .object({
              value: z.string().regex(/^\d+$/u).transform(Number).pipe(ErrorAllocationSchema),
            })
            .parse(storedCeiling).value
        : 0;
      this.maintenanceCeiling = Math.max(this.allocationBytes, previousCeiling);
      this.saveMaintenanceCeiling();
      this.reclaiming = sqliteFilesBytes(this.databasePath) > this.allocationBytes;
      return this.stats();
    }
    if (!this.generation) {
      throw new Error('Local error diagnostic owner is not initialized');
    }
    switch (command.operation) {
      case 'insert':
        return this.insert(command.payload);
      case 'stats':
        return this.stats();
      case 'query':
        return this.query(command.payload);
      case 'detail':
        return this.detail(command.payload.id);
      case 'configure':
        this.generation = command.payload.generation;
        this.maintenanceCeiling = Math.max(
          this.maintenanceCeiling,
          command.payload.allocationBytes,
        );
        this.saveMaintenanceCeiling();
        this.allocationBytes = command.payload.allocationBytes;
        this.reclaiming ||= sqliteFilesBytes(this.databasePath) > this.allocationBytes;
        return this.stats();
      case 'clear': {
        // Revocation survives a failed DELETE; an old queued write cannot republish.
        this.generation = command.payload.generation;
        const records = CountSchema.parse(
          this.raw.prepare('SELECT count(*) AS count FROM error_window_records').get(),
        ).count;
        this.raw
          .transaction(() => this.raw.prepare('DELETE FROM error_window_records').run())
          .immediate();
        return { generation: this.generation, records };
      }
      case 'maintain':
        return this.maintain();
    }
  }

  private insert(payload: Extract<ErrorWindowCommand, { operation: 'insert' }>['payload']) {
    if (payload.generation !== this.generation) {
      throw new Error('Local error diagnostic write rejected: cleared_generation');
    }
    const record = decodeErrorRecord(payload.body);
    if (record.role !== this.role) {
      throw new Error('Local error diagnostic role mismatch');
    }
    const duplicate = this.raw
      .prepare('SELECT body=? AS identical FROM error_window_records WHERE record_id=?')
      .get(payload.body, record.id);
    if (duplicate) {
      if (z.object({ identical: z.literal(1) }).safeParse(duplicate).success === false) {
        throw new Error('Local error diagnostic identity conflict');
      }
      return { persisted: true, duplicate: true };
    }
    const bytes = Buffer.byteLength(payload.body, 'utf8');
    try {
      const reserve = Math.min(32 * 1024 * 1024, Math.floor(this.allocationBytes / 8));
      this.disk.assertCanWrite(bytes + 4096, this.allocationBytes - reserve);
    } catch (error) {
      if (
        error instanceof SqliteDiskAdmissionError &&
        (error.reason === 'disk_budget' || error.reason === 'checkpoint_busy')
      ) {
        this.reclaiming = true;
      }
      throw error;
    }
    let message = record.message.slice(0, 256);
    const last = message.charCodeAt(message.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      message = message.slice(0, -1);
    }
    this.raw
      .prepare(
        'INSERT INTO error_window_records(record_id,created_at,source,category,request_id,attempt_id,status,message,body,bytes) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        record.id,
        record.createdAt,
        record.source,
        record.category,
        record.requestId,
        record.attemptId,
        record.status,
        message,
        payload.body,
        bytes,
      );
    return { persisted: true, duplicate: false };
  }

  private query(input: Extract<ErrorWindowCommand, { operation: 'query' }>['payload']) {
    const throughSequence =
      input.throughSequence ??
      HighWaterSchema.parse(
        this.raw
          .prepare('SELECT coalesce(max(sequence),0) AS sequence FROM error_window_records')
          .get(),
      ).sequence;
    const clauses = ['sequence>?', 'sequence<=?'];
    const values: Array<string | number> = [input.afterSequence, throughSequence];
    for (const [column, value] of [
      ['source', input.source],
      ['category', input.category],
      ['request_id', input.requestId],
    ] as const) {
      if (value !== undefined) {
        clauses.push(`${column}=?`);
        values.push(value);
      }
    }
    const records = z
      .array(ErrorWindowMetadataSchema)
      .max(201)
      .parse(
        this.raw
          .prepare(
            `SELECT sequence,record_id AS id,created_at AS createdAt,source,category,request_id AS requestId,attempt_id AS attemptId,status,message,bytes FROM error_window_records WHERE ${clauses.join(' AND ')} ORDER BY sequence LIMIT ?`,
          )
          .all(...values, input.limit + 1),
      );
    const complete = records.length <= input.limit;
    const selected = records.slice(0, input.limit);
    const page = ErrorWindowPageSchema.parse({
      generation: this.generation,
      records: selected,
      throughSequence,
      complete,
      nextSequence: complete ? null : selected.at(-1)?.sequence,
    });
    if (Buffer.byteLength(JSON.stringify(page), 'utf8') > MAX_PAGE_BYTES) {
      throw new Error('Local error diagnostic metadata exceeds the page budget');
    }
    return page;
  }

  private detail(id: string) {
    const size = this.raw
      .prepare(
        'SELECT length(cast(body AS blob)) AS bytes FROM error_window_records WHERE record_id=?',
      )
      .get(id);
    if (!size) {
      return null;
    }
    if (BytesSchema.parse(size).bytes > MAX_ERROR_RECORD_BYTES) {
      throw new Error('Local error diagnostic exceeds the record budget');
    }
    const row = z
      .object({ body: z.string() })
      .parse(this.raw.prepare('SELECT body FROM error_window_records WHERE record_id=?').get(id));
    const record = decodeErrorRecord(row.body);
    if (record.role !== this.role || record.id !== id) {
      throw new Error('Local error diagnostic ownership mismatch');
    }
    return record;
  }

  private stats() {
    return {
      generation: this.generation,
      role: this.role,
      allocationBytes: this.allocationBytes,
      maintenanceCeiling: this.maintenanceCeiling,
      reclaiming: this.reclaiming,
      databaseBytes: sqliteFilesBytes(this.databasePath),
      records: CountSchema.parse(
        this.raw.prepare('SELECT count(*) AS count FROM error_window_records').get(),
      ).count,
    };
  }

  private saveMaintenanceCeiling(): void {
    const previous = this.raw
      .prepare("SELECT value FROM error_window_meta WHERE key='maintenance_ceiling'")
      .get();
    if (
      previous &&
      z.object({ value: z.string() }).parse(previous).value === String(this.maintenanceCeiling)
    ) {
      return;
    }
    this.disk.assertCanWrite(256, this.maintenanceCeiling, false);
    this.raw
      .prepare(
        "INSERT INTO error_window_meta(key,value) VALUES('maintenance_ceiling',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(String(this.maintenanceCeiling));
  }

  private maintain() {
    const before = sqliteFilesBytes(this.databasePath);
    const target = Math.floor(this.allocationBytes * 0.7);
    if ((!this.reclaiming && before <= this.allocationBytes) || before <= target) {
      this.reclaiming = false;
      this.maintenanceCeiling = this.allocationBytes;
      this.saveMaintenanceCeiling();
      return { removedRecords: 0, moreWorkPending: false, databaseBytes: before };
    }
    this.reclaiming = true;
    const initialCheckpoint = z
      .object({ busy: z.number().int().nonnegative() })
      .parse(this.raw.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get());
    if (initialCheckpoint.busy !== 0) {
      return {
        removedRecords: 0,
        moreWorkPending: false,
        databaseBytes: before,
        blockedReason: 'checkpoint_busy',
      };
    }
    const freeBefore = z
      .number()
      .int()
      .safe()
      .nonnegative()
      .parse(this.raw.pragma('freelist_count', { simple: true }));
    this.raw.pragma('incremental_vacuum(128)');
    this.raw.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    const compacted = sqliteFilesBytes(this.databasePath);
    if (compacted <= target) {
      this.reclaiming = false;
      this.maintenanceCeiling = this.allocationBytes;
      this.saveMaintenanceCeiling();
      return {
        removedRecords: 0,
        moreWorkPending: false,
        databaseBytes: compacted,
        reclaimedBytes: Math.max(0, before - compacted),
      };
    }
    const rows = z
      .array(
        z.object({
          sequence: z.number().int().safe().positive(),
          bytes: z.number().int().safe().nonnegative(),
        }),
      )
      .max(32)
      .parse(
        this.raw
          .prepare(
            'SELECT sequence,length(cast(body AS blob)) AS bytes FROM error_window_records ORDER BY created_at,sequence LIMIT 32',
          )
          .all(),
      );
    const ids: number[] = [];
    let bytes = 0;
    for (const row of rows) {
      if (bytes + row.bytes > MAX_ERROR_RECORD_BYTES) {
        break;
      }
      ids.push(row.sequence);
      bytes += row.bytes;
    }
    if (ids.length === 0 && rows.length > 0) {
      return {
        removedRecords: 0,
        moreWorkPending: false,
        databaseBytes: compacted,
        blockedReason: 'oversized_record',
      };
    }
    if (ids.length > 0) {
      for (;;) {
        try {
          this.disk.assertCanWrite(bytes + 4096, this.maintenanceCeiling, false);
          break;
        } catch (error) {
          if (
            !(error instanceof SqliteDiskAdmissionError) ||
            error.reason !== 'disk_budget' ||
            ids.length === 1
          ) {
            throw error;
          }
          const keep = Math.max(1, Math.floor(ids.length / 2));
          ids.splice(keep);
          bytes = rows.slice(0, keep).reduce((total, row) => total + row.bytes, 0);
        }
      }
      this.raw
        .transaction(() =>
          this.raw
            .prepare(
              `DELETE FROM error_window_records WHERE sequence IN (${ids.map(() => '?').join(',')})`,
            )
            .run(...ids),
        )
        .immediate();
    }
    let checkpoint = z
      .object({ busy: z.number().int().nonnegative() })
      .parse(this.raw.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get());
    if (checkpoint.busy === 0) {
      this.raw.pragma('incremental_vacuum(128)');
      checkpoint = z
        .object({ busy: z.number().int().nonnegative() })
        .parse(this.raw.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get());
    }
    const after = sqliteFilesBytes(this.databasePath);
    const freeAfter = z
      .number()
      .int()
      .safe()
      .nonnegative()
      .parse(this.raw.pragma('freelist_count', { simple: true }));
    const progress = ids.length > 0 || after < before || freeAfter < freeBefore;
    const remaining = CountSchema.parse(
      this.raw.prepare('SELECT count(*) AS count FROM error_window_records').get(),
    ).count;
    if (after <= target) {
      this.reclaiming = false;
      this.maintenanceCeiling = this.allocationBytes;
      this.saveMaintenanceCeiling();
    }
    const moreWorkPending =
      checkpoint.busy === 0 && after > target && progress && (remaining > 0 || freeAfter > 0);
    return {
      removedRecords: ids.length,
      reclaimedBytes: Math.max(0, before - after),
      databaseBytes: after,
      moreWorkPending,
      ...(checkpoint.busy
        ? { blockedReason: 'checkpoint_busy' }
        : after > target && !moreWorkPending
          ? { blockedReason: 'no_progress' }
          : {}),
    };
  }
}
