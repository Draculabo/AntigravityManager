import fs from 'node:fs';
import path from 'node:path';

export type AuditArchiveUsage =
  | { status: 'complete'; bytes: number; files: number }
  | { status: 'unknown' };

const MAX_DIRECTORY_ENTRIES = 4096;

/** Metadata only: never open historical databases or follow a profile-local link. */
export function auditArchiveUsage(databasePath: string): AuditArchiveUsage {
  let directory: fs.Dir | undefined;
  try {
    directory = fs.opendirSync(path.dirname(databasePath));
    const prefix = path.basename(databasePath);
    let bytes = 0;
    let files = 0;
    for (let scanned = 0; scanned < MAX_DIRECTORY_ENTRIES; scanned += 1) {
      const entry = directory.readSync();
      if (!entry) {
        return { status: 'complete', bytes, files };
      }
      if (!entry.name.startsWith(`${prefix}.`)) {
        continue;
      }
      const suffix = entry.name.slice(prefix.length);
      if (!/^\.(?:schema-v\d+-backup-|corrupt-)\d+(?:-wal|-shm)?$/u.test(suffix)) {
        continue;
      }
      const stat = fs.lstatSync(path.join(path.dirname(databasePath), entry.name));
      if (
        !stat.isFile() ||
        !Number.isSafeInteger(stat.size) ||
        stat.size < 0 ||
        !Number.isSafeInteger(bytes + stat.size)
      ) {
        return { status: 'unknown' };
      }
      bytes += stat.size;
      files += 1;
    }
    return { status: 'unknown' };
  } catch {
    // Inaccessible, disappearing or incomplete inventories must never look like zero usage.
    return { status: 'unknown' };
  } finally {
    directory?.closeSync();
  }
}
