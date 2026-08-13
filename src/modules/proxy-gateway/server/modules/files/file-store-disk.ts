import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isStoreFileId, type StoredFileRecord } from './file-store.types';

/**
 * Everything the file store does to a disk.
 *
 * Split out from `FileContentStore` so the service holds only policy —
 * handles, ceilings, TTL, deduplication — and every path, rename and parse
 * lives here. The crash-safety rule is the reason this is one place: content
 * and index are both written to `tmp/` and renamed into position, so a kill
 * mid-write can leave a stray temp file but never a half-written blob the
 * index already advertises.
 *
 * Layout under the configured root:
 * ```
 * index.json           metadata for every live handle
 * blobs/<aa>/<sha256>  content, one copy per distinct digest
 * tmp/                 staging area for the write-then-rename dance
 * ```
 */

interface FileIndexDocument {
  version: 1;
  files: StoredFileRecord[];
}

const INDEX_FILE_NAME = 'index.json';
const BLOB_DIRECTORY = 'blobs';
const TEMP_DIRECTORY = 'tmp';

export class FileStoreDisk {
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(private readonly rootDirectory: string) {}

  /**
   * Creates the layout, clears temp staging left by a previous run, and returns
   * every record the index still holds. A torn or unreadable index yields an
   * empty list rather than throwing: an unusable index is a store with no
   * handles, not a store that refuses to start.
   */
  public async open(): Promise<{ records: StoredFileRecord[]; indexEntryCount: number }> {
    await mkdir(join(this.rootDirectory, BLOB_DIRECTORY), { recursive: true });
    await mkdir(join(this.rootDirectory, TEMP_DIRECTORY), { recursive: true });
    await this.discardStaleTempFiles();

    let parsed: FileIndexDocument | null = null;
    try {
      const raw = await readFile(join(this.rootDirectory, INDEX_FILE_NAME), 'utf8');
      parsed = JSON.parse(raw) as FileIndexDocument;
    } catch {
      parsed = null;
    }

    const entries = Array.isArray(parsed?.files) ? parsed.files : [];
    return {
      records: entries.filter(isValidRecord),
      indexEntryCount: entries.length,
    };
  }

  public hasBlob(sha256: string): boolean {
    return existsSync(this.blobPath(sha256));
  }

  public readBlob(sha256: string): Promise<Buffer> {
    return readFile(this.blobPath(sha256));
  }

  public async writeBlob(sha256: string, bytes: Buffer): Promise<void> {
    await mkdir(join(this.rootDirectory, BLOB_DIRECTORY, sha256.slice(0, 2)), { recursive: true });
    const temporaryPath = this.temporaryPath(`${sha256}.part`);
    await writeFile(temporaryPath, bytes);
    await rename(temporaryPath, this.blobPath(sha256));
  }

  public async removeBlob(sha256: string): Promise<void> {
    await rm(this.blobPath(sha256), { force: true });
  }

  /** Reclaims content no live record points at. */
  public async removeOrphanBlobs(referenced: Set<string>): Promise<void> {
    const blobRoot = join(this.rootDirectory, BLOB_DIRECTORY);
    let shards: string[];
    try {
      shards = await readdir(blobRoot);
    } catch {
      return;
    }
    for (const shard of shards) {
      let names: string[];
      try {
        names = await readdir(join(blobRoot, shard));
      } catch {
        continue;
      }
      for (const name of names) {
        if (!referenced.has(name)) {
          await rm(join(blobRoot, shard, name), { force: true });
        }
      }
    }
  }

  /**
   * Serialised, atomic index write. Concurrent callers chain onto the same
   * promise so two writers cannot interleave a rename over each other, and the
   * index is always renamed into place rather than truncated and rewritten.
   */
  public persistIndex(records: StoredFileRecord[]): Promise<void> {
    const snapshot: FileIndexDocument = { version: 1, files: records };
    this.pendingWrite = this.pendingWrite
      .catch(() => undefined)
      .then(async () => {
        const temporaryPath = this.temporaryPath('index.json');
        await writeFile(temporaryPath, JSON.stringify(snapshot), 'utf8');
        await rename(temporaryPath, join(this.rootDirectory, INDEX_FILE_NAME));
      });
    return this.pendingWrite;
  }

  private blobPath(sha256: string): string {
    return join(this.rootDirectory, BLOB_DIRECTORY, sha256.slice(0, 2), sha256);
  }

  private temporaryPath(suffix: string): string {
    return join(this.rootDirectory, TEMP_DIRECTORY, `${process.pid}.${Date.now()}.${suffix}`);
  }

  private async discardStaleTempFiles(): Promise<void> {
    const temporaryRoot = join(this.rootDirectory, TEMP_DIRECTORY);
    try {
      for (const name of await readdir(temporaryRoot)) {
        await rm(join(temporaryRoot, name), { force: true });
      }
    } catch {
      // No temp directory yet is the normal first-run case.
    }
  }
}

function isValidRecord(value: unknown): value is StoredFileRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<StoredFileRecord>;
  return (
    typeof record.id === 'string' &&
    isStoreFileId(record.id) &&
    typeof record.sha256 === 'string' &&
    /^[0-9a-f]{64}$/u.test(record.sha256) &&
    typeof record.sizeBytes === 'number' &&
    typeof record.mimeType === 'string' &&
    typeof record.displayName === 'string' &&
    typeof record.createTimeMs === 'number' &&
    typeof record.updateTimeMs === 'number' &&
    typeof record.expireTimeMs === 'number'
  );
}
