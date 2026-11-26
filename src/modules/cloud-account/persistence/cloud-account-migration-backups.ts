import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { asc, eq, placeholder, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { isEqual } from 'lodash-es';
import { z } from 'zod';
import { accounts } from '@/shared/persistence/database/schema';

const ConversionFieldsSchema = z.object({
  id: z.string(),
  tokenJson: z.string(),
  quotaJson: z.string().nullable(),
  healthJson: z.string().nullable(),
});
export type AccountConversionFields = z.infer<typeof ConversionFieldsSchema>;

/** Read the persisted fields that must remain unchanged across asynchronous key/backup work. */
export function readAccountConversionFields(
  database: Database.Database,
): AccountConversionFields[] {
  const rows = drizzle(database)
    .select({
      id: accounts.id,
      tokenJson: accounts.tokenJson,
      quotaJson: accounts.quotaJson,
      healthJson: accounts.healthJson,
    })
    .from(accounts)
    .orderBy(asc(accounts.id))
    .all();
  const parsed = z.array(ConversionFieldsSchema).safeParse(rows);
  if (!parsed.success) {
    throw new Error('Account conversion fields are invalid');
  }
  return parsed.data;
}

function verifyBackup(file: string, expected: AccountConversionFields[]): void {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (
      database.pragma('quick_check', { simple: true }) !== 'ok' ||
      !isEqual(readAccountConversionFields(database), expected)
    ) {
      throw new Error('Account conversion backup could not be confirmed');
    }
  } finally {
    database.close();
  }
}

/** Completed pairs are permanent history; failed attempts retain their recoverable artifacts. */
export async function preserveCloudAccountMigrationBackups(
  database: Database.Database,
  dbPath: string,
  original: AccountConversionFields[],
  converted: AccountConversionFields[],
): Promise<void> {
  // mkdtemp creates a new private directory, so retries never overwrite previous attempts.
  const directory = fs.mkdtempSync(`${dbPath}.account-migration-`);
  const encryptedPath = path.join(directory, 'encrypted.db');
  const pendingPath = path.join(directory, 'decrypted.pending.db');
  const decryptedPath = path.join(directory, 'decrypted.db');
  // SQLite's online backup includes committed WAL pages, unlike copying the active DB file.
  await database.backup(encryptedPath);
  if (process.platform !== 'win32') {
    fs.chmodSync(encryptedPath, 0o600);
  }
  const encrypted = new Database(encryptedPath, { fileMustExist: true });
  try {
    // Normalize the backup only; opening a WAL-mode image read-only can create sidecars.
    encrypted.pragma('journal_mode = DELETE');
  } finally {
    encrypted.close();
  }
  verifyBackup(encryptedPath, original);
  fs.copyFileSync(encryptedPath, pendingPath, fs.constants.COPYFILE_EXCL);
  const candidate = new Database(pendingPath, { fileMustExist: true });
  try {
    // A completed backup is self-contained and must not depend on a transient WAL/SHM sibling.
    candidate.pragma('journal_mode = DELETE');
    drizzle(candidate).transaction((tx) => {
      const update = tx
        .update(accounts)
        .set({
          tokenJson: sql`${placeholder('tokenJson')}`,
          quotaJson: sql`${placeholder('quotaJson')}`,
          healthJson: sql`${placeholder('healthJson')}`,
        })
        .where(eq(accounts.id, placeholder('id')))
        .prepare();
      for (const row of converted) {
        if (update.run(row).changes !== 1) {
          throw new Error('Account conversion backup update failed');
        }
      }
    });
  } finally {
    candidate.close();
  }
  const replacements = new Map(converted.map((row) => [row.id, row]));
  const expected = original.map((row) => replacements.get(row.id) ?? row);
  verifyBackup(pendingPath, expected);
  fs.renameSync(pendingPath, decryptedPath);
  verifyBackup(decryptedPath, expected);
}
