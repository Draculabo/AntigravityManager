import fs from 'node:fs';

/**
 * Moves a SQLite database and its live sidecars aside without deleting evidence.
 * The caller must close every connection before invoking this helper.
 */
export function preserveCorruptSqliteDatabase(databasePath: string): string | null {
  if (!fs.existsSync(databasePath)) {
    return null;
  }
  const backupPath = `${databasePath}.corrupt-${Date.now()}`;
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${databasePath}${suffix}`;
    if (fs.existsSync(source)) {
      fs.renameSync(source, `${backupPath}${suffix}`);
    }
  }
  return backupPath;
}
