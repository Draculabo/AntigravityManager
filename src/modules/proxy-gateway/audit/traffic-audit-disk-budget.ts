import type Database from 'better-sqlite3';
import {
  SqliteDiskAdmissionError,
  SqliteWriteBudget,
  sqliteFilesBytes,
} from '@/shared/persistence/database/sqlite-write-budget';

export type AuditDiskRejection =
  | 'audit_disk_budget'
  | 'audit_disk_usage_unknown'
  | 'audit_checkpoint_busy'
  | 'audit_reclaim_failed'
  | 'audit_read_only'
  | 'audit_disk_full';

export class AuditDiskAdmissionError extends Error {
  constructor(
    readonly reason: AuditDiskRejection,
    options?: ErrorOptions,
    readonly metadataUnpersisted = false,
  ) {
    super(
      `Traffic audit write rejected: ${reason}${metadataUnpersisted ? '; capture_metadata_unpersisted' : ''}`,
      options,
    );
  }
}

/** SQLite errors keep their original cause; only closed storage identities cross the worker. */
export function toAuditDiskAdmissionError(error: unknown): AuditDiskAdmissionError | null {
  if (error instanceof AuditDiskAdmissionError) {
    return error;
  }
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    if (error.code === 'SQLITE_FULL') {
      return new AuditDiskAdmissionError('audit_disk_full', { cause: error });
    }
    if (error.code === 'SQLITE_READONLY' || error.code.startsWith('SQLITE_READONLY_')) {
      return new AuditDiskAdmissionError('audit_read_only', { cause: error });
    }
  }
  return null;
}

export function auditDiskRejection(error: unknown): AuditDiskRejection | null {
  const message =
    error instanceof Error ? error.message.replace(/; capture_metadata_unpersisted$/u, '') : '';
  switch (message) {
    case 'Traffic audit write rejected: audit_disk_budget':
      return 'audit_disk_budget';
    case 'Traffic audit write rejected: audit_disk_usage_unknown':
      return 'audit_disk_usage_unknown';
    case 'Traffic audit write rejected: audit_checkpoint_busy':
      return 'audit_checkpoint_busy';
    case 'Traffic audit write rejected: audit_reclaim_failed':
      return 'audit_reclaim_failed';
    case 'Traffic audit write rejected: audit_read_only':
      return 'audit_read_only';
    case 'Traffic audit write rejected: audit_disk_full':
      return 'audit_disk_full';
    default:
      return null;
  }
}

/** A missing sidecar is zero; permission/I/O failures never establish available capacity. */
export function auditSqliteFilesBytes(databasePath: string): number {
  try {
    return sqliteFilesBytes(databasePath);
  } catch (error) {
    throw new AuditDiskAdmissionError('audit_disk_usage_unknown', { cause: error });
  }
}

/**
 * The worker executes writes serially, without yielding between this check and commit.
 * Queue acceptance reserves memory only. No queued command owns a future disk allocation;
 * each must pass this check anew after all earlier commits/failures.
 */
export class TrafficAuditDiskBudget {
  private readonly budget: SqliteWriteBudget;
  constructor(databasePath: string, raw: Database.Database) {
    this.budget = new SqliteWriteBudget(databasePath, raw);
  }

  assertCanWrite(payloadBytes: number, maxDiskBytes: number, growing = true): void {
    try {
      this.budget.assertCanWrite(payloadBytes, maxDiskBytes, growing);
    } catch (error) {
      if (error instanceof SqliteDiskAdmissionError) {
        throw new AuditDiskAdmissionError(`audit_${error.reason}`, { cause: error });
      }
      throw error;
    }
  }
}
