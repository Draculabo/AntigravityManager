import fs from 'node:fs';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import { sqliteSchema } from '@/shared/persistence/database/sqlite-metadata';
import { auditSchemaMeta } from './traffic-audit.schema';
import addAttemptTiming from './migrations/v7-attempt-timing.sql?raw';
import addAttemptUsage from './migrations/v5-attempt-usage.sql?raw';
import addAttemptIdentity from './migrations/v6-attempt-identity.sql?raw';
import bootstrapAuditV7 from './migrations/v7-bootstrap.sql?raw';

const SCHEMA_VERSION = 7;

function hasTable(orm: ReturnType<typeof drizzle>, name: string): boolean {
  return Boolean(
    orm
      .select({ name: sqliteSchema.name })
      .from(sqliteSchema)
      .where(and(eq(sqliteSchema.type, 'table'), eq(sqliteSchema.name, name)))
      .get(),
  );
}

function preservePreviousVersion(
  database: Database.Database,
  databasePath: string,
  version: number,
): void {
  const source = fs.lstatSync(databasePath);
  if (!source.isFile() || source.isSymbolicLink()) {
    throw new Error('Traffic audit migration requires a regular database file');
  }
  const checkpoint = database.pragma('wal_checkpoint(TRUNCATE)');
  const checkpointResult = z
    .array(z.object({ busy: z.literal(0) }))
    .nonempty()
    .safeParse(checkpoint);
  if (!checkpointResult.success) {
    throw new Error('Traffic audit migration could not checkpoint the existing database');
  }
  const backupPath = `${databasePath}.schema-v${version}-backup-${Date.now()}-${randomUUID()}`;
  const descriptor = fs.openSync(backupPath, 'wx', 0o600);
  fs.closeSync(descriptor);
  database.prepare('VACUUM INTO ?').run(backupPath);
  const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    if (
      backup.pragma('user_version', { simple: true }) !== version ||
      backup.pragma('quick_check', { simple: true }) !== 'ok'
    ) {
      throw new Error('Traffic audit migration backup verification failed');
    }
  } finally {
    backup.close();
  }
  const backupDescriptor = fs.openSync(backupPath, 'r+');
  try {
    fs.fsyncSync(backupDescriptor);
  } finally {
    fs.closeSync(backupDescriptor);
  }
}

export function configureTrafficAuditDatabase(database: Database.Database): void {
  database.pragma('auto_vacuum = INCREMENTAL');
  if (database.pragma('auto_vacuum', { simple: true }) !== 2) {
    database.exec('VACUUM');
  }
  if (database.pragma('auto_vacuum', { simple: true }) !== 2) {
    throw new Error('Traffic audit database could not enable incremental vacuum');
  }
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = NORMAL');
  database.pragma('busy_timeout = 5000');
  database.pragma('foreign_keys = ON');
  database.pragma('temp_store = MEMORY');
  database.pragma('cache_size = -16000');
}

export function openTrafficAuditDatabase(databasePath: string): Database.Database {
  let database = new Database(databasePath);
  const schemaVersion = Number(database.pragma('user_version', { simple: true }));
  const hasRequestLogs = hasTable(drizzle(database), 'request_logs');
  if (schemaVersion > SCHEMA_VERSION) {
    database.close();
    throw new Error(`Unsupported traffic audit schema version: ${schemaVersion}`);
  }
  if (hasRequestLogs && (schemaVersion === 4 || schemaVersion === 5 || schemaVersion === 6)) {
    try {
      preservePreviousVersion(database, databasePath, schemaVersion);
    } catch (error) {
      database.close();
      throw error;
    }
  } else if (hasRequestLogs && schemaVersion < 4) {
    database.close();
    const backupPath = `${databasePath}.schema-v${schemaVersion}-backup-${Date.now()}`;
    for (const suffix of ['', '-wal', '-shm']) {
      const source = `${databasePath}${suffix}`;
      if (fs.existsSync(source)) {
        fs.renameSync(source, `${backupPath}${suffix}`);
      }
    }
    database = new Database(databasePath);
  }
  return database;
}

export function initializeTrafficAuditSchema(database: Database.Database): void {
  const schemaVersion = Number(database.pragma('user_version', { simple: true }));
  if (!Number.isInteger(schemaVersion) || schemaVersion > SCHEMA_VERSION) {
    throw new Error(`Unsupported traffic audit schema version: ${schemaVersion}`);
  }
  const orm = drizzle(database);
  const hasRequestLogs = hasTable(orm, 'request_logs');
  const hasPayloads = hasTable(orm, 'audit_payloads');
  if (schemaVersion >= 4 && hasRequestLogs && !hasPayloads) {
    throw new Error(
      'Unsupported prototype traffic audit schema; preserve the prototype database and create a fresh database',
    );
  }

  database.transaction(() => {
    if (schemaVersion >= 4 && schemaVersion <= 6 && hasRequestLogs) {
      database.exec(addAttemptTiming);
    }
    if (schemaVersion === 4 && hasRequestLogs) {
      database.exec(addAttemptUsage);
    }
    if ((schemaVersion === 4 || schemaVersion === 5) && hasRequestLogs) {
      database.exec(addAttemptIdentity);
    }
    database.exec(bootstrapAuditV7);
    for (const [key, value] of [
      ['schema_version', String(SCHEMA_VERSION)],
      ['layout', 'classified-chunked-payload-v7'],
    ] as const) {
      orm
        .insert(auditSchemaMeta)
        .values({ key, value })
        .onConflictDoUpdate({ target: auditSchemaMeta.key, set: { value } })
        .run();
    }
    database.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}
