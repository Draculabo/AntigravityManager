import fs from 'node:fs';
import type Database from 'better-sqlite3';

export type SqliteDiskRejection =
  | 'disk_budget'
  | 'disk_usage_unknown'
  | 'checkpoint_busy'
  | 'reclaim_failed'
  | 'read_only'
  | 'disk_full';

export class SqliteDiskAdmissionError extends Error {
  constructor(
    readonly reason: SqliteDiskRejection,
    options?: ErrorOptions,
  ) {
    super(`SQLite write rejected: ${reason}`, options);
  }
}

/** Missing sidecars are zero; any other measurement failure means capacity is unknown. */
export function sqliteFilesBytes(databasePath: string): number {
  let bytes = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      bytes += fs.statSync(databasePath + suffix).size;
    } catch (error) {
      if (suffix !== '' && error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        continue;
      }
      throw new SqliteDiskAdmissionError('disk_usage_unknown', { cause: error });
    }
  }
  return bytes;
}

/** Serial owners check immediately before commit; queued commands reserve memory only. */
export class SqliteWriteBudget {
  constructor(
    private readonly databasePath: string,
    private readonly raw: Database.Database,
  ) {}

  assertCanWrite(payloadBytes: number, maxDiskBytes: number, growing = true): void {
    if (this.raw.readonly) {
      throw new SqliteDiskAdmissionError('read_only');
    }
    const pageSize = Number(this.raw.pragma('page_size', { simple: true }));
    if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
      throw new SqliteDiskAdmissionError('disk_usage_unknown');
    }
    const pages = Math.ceil(payloadBytes / pageSize) * 3 + 4;
    const reservation = pages * (pageSize + 24) + (growing ? pageSize * 16 : 0);
    if (sqliteFilesBytes(this.databasePath) + reservation <= maxDiskBytes) {
      return;
    }
    const previousTimeout = Number(this.raw.pragma('busy_timeout', { simple: true }));
    let busy = false;
    try {
      this.raw.pragma('busy_timeout = 0');
      busy =
        this.raw.prepare<[], { busy: number }>('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy !== 0;
      if (
        !busy &&
        Number(this.raw.pragma('auto_vacuum', { simple: true })) === 2 &&
        Number(this.raw.pragma('freelist_count', { simple: true })) > 0
      ) {
        this.raw.pragma('incremental_vacuum(128)');
        busy =
          this.raw.prepare<[], { busy: number }>('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy !==
          0;
      }
    } catch (error) {
      throw new SqliteDiskAdmissionError('reclaim_failed', { cause: error });
    } finally {
      this.raw.pragma(`busy_timeout = ${previousTimeout}`);
    }
    if (sqliteFilesBytes(this.databasePath) + reservation <= maxDiskBytes) {
      return;
    }
    throw new SqliteDiskAdmissionError(busy ? 'checkpoint_busy' : 'disk_budget');
  }
}
