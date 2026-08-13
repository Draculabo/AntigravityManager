import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Inject, Injectable, Optional } from '@nestjs/common';

import { FileStoreDisk } from './file-store-disk';
import { normalizeMimeType, resolveEffectiveMimeType, sniffMimeType } from './file-mime-sniff';
import {
  DEFAULT_FILE_TTL_MS,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_STORE_BYTES,
  DEFAULT_SWEEP_INTERVAL_MS,
  FileStoreError,
  isStoreFileId,
  type FileStoreOptions,
  type ListFilesOptions,
  type ListFilesResult,
  type PutFileInput,
  type StoredFileRecord,
} from './file-store.types';

export const FILE_STORE_OPTIONS = Symbol('FILE_STORE_OPTIONS');

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;

/**
 * Durable, content-addressed store for client uploaded files.
 *
 * Protocol-agnostic on purpose: Gemini, OpenAI and Anthropic file endpoints are
 * thin adapters over this one store, and reference expansion reads from it
 * through the same `get`. Nothing in here knows what a `fileUri` or a
 * `file_id` looks like.
 *
 * This class owns policy only — handles, size ceilings, TTL and deduplication.
 * Every path, rename and parse lives in {@link FileStoreDisk}, which is also
 * where the crash-safety guarantee is implemented.
 */
@Injectable()
export class FileContentStore {
  private readonly disk: FileStoreDisk;
  private readonly maxFileBytes: number;
  private readonly maxStoreBytes: number;
  private readonly ttlMs: number;
  private readonly records = new Map<string, StoredFileRecord>();
  private readonly sweepTimer?: NodeJS.Timeout;

  private loaded = false;

  constructor(@Optional() @Inject(FILE_STORE_OPTIONS) options?: FileStoreOptions) {
    this.disk = new FileStoreDisk(
      options?.rootDirectory ?? join(tmpdir(), 'antigravity-manager', 'proxy-files'),
    );
    this.maxFileBytes = options?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxStoreBytes = options?.maxStoreBytes ?? DEFAULT_MAX_STORE_BYTES;
    this.ttlMs = options?.ttlMs ?? DEFAULT_FILE_TTL_MS;

    const sweepIntervalMs = options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    if (sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => {
        void this.sweep().catch(() => undefined);
      }, sweepIntervalMs);
      this.sweepTimer.unref?.();
    }
  }

  public getLimits(): { maxFileBytes: number; maxStoreBytes: number; ttlMs: number } {
    return {
      maxFileBytes: this.maxFileBytes,
      maxStoreBytes: this.maxStoreBytes,
      ttlMs: this.ttlMs,
    };
  }

  public onModuleDestroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
    }
  }

  /**
   * Stores bytes and returns the handle.
   *
   * The handle is derived from the content digest, so uploading the same bytes
   * twice returns the same handle over one blob. A repeat upload refreshes the
   * expiry and adopts a newly supplied display name, because the second caller
   * is as entitled to the handle's remaining lifetime as the first.
   */
  public async put(input: PutFileInput): Promise<StoredFileRecord> {
    await this.load();

    const bytes = input.bytes;
    if (!bytes || bytes.length === 0) {
      throw FileStoreError.empty();
    }
    if (bytes.length > this.maxFileBytes) {
      throw FileStoreError.tooLarge(bytes.length, this.maxFileBytes);
    }

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const id = sha256.slice(0, 32);
    const now = Date.now();
    const existing = this.records.get(id);

    if (!existing && this.totalBytes() + bytes.length > this.maxStoreBytes) {
      await this.sweep();
      if (this.totalBytes() + bytes.length > this.maxStoreBytes) {
        throw FileStoreError.storeFull(this.maxStoreBytes);
      }
    }

    const declaredMimeType = normalizeMimeType(input.declaredMimeType);
    const sniffedMimeType = sniffMimeType(bytes);
    const record: StoredFileRecord = {
      id,
      sha256,
      sizeBytes: bytes.length,
      mimeType: resolveEffectiveMimeType(declaredMimeType, sniffedMimeType),
      ...(declaredMimeType ? { declaredMimeType } : {}),
      ...(sniffedMimeType ? { sniffedMimeType } : {}),
      displayName: sanitizeDisplayName(input.displayName) ?? existing?.displayName ?? id,
      ...((input.purpose ?? existing?.purpose)
        ? { purpose: input.purpose ?? existing?.purpose }
        : {}),
      createTimeMs: existing?.createTimeMs ?? now,
      updateTimeMs: now,
      expireTimeMs: now + this.ttlMs,
    };

    if (!existing || !this.disk.hasBlob(sha256)) {
      await this.disk.writeBlob(sha256, bytes);
    }
    this.records.set(id, record);
    await this.persistIndex();
    return { ...record };
  }

  /** Metadata only. Throws `not_found` / `expired` rather than returning null. */
  public async stat(id: string): Promise<StoredFileRecord> {
    await this.load();
    return { ...this.requireLive(id) };
  }

  /** Metadata plus content. */
  public async get(id: string): Promise<{ record: StoredFileRecord; bytes: Buffer }> {
    await this.load();
    const record = this.requireLive(id);
    try {
      const bytes = await this.disk.readBlob(record.sha256);
      return { record: { ...record }, bytes };
    } catch {
      // The index promised content the disk no longer has. Drop the handle so
      // the next call reports a clean "never issued" instead of retrying a
      // read that cannot succeed.
      this.records.delete(record.id);
      await this.persistIndex();
      throw FileStoreError.notFound(id);
    }
  }

  public async list(options: ListFilesOptions = {}): Promise<ListFilesResult> {
    await this.load();
    await this.sweep();

    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
    const ordered = [...this.records.values()].sort(
      (left, right) => right.createTimeMs - left.createTimeMs || left.id.localeCompare(right.id),
    );
    const startIndex = options.pageToken
      ? ordered.findIndex((record) => record.id === options.pageToken)
      : 0;
    const offset = startIndex < 0 ? ordered.length : startIndex;
    const page = ordered.slice(offset, offset + limit);
    const next = ordered[offset + limit];

    return {
      files: page.map((record) => ({ ...record })),
      ...(next ? { nextPageToken: next.id } : {}),
    };
  }

  /** Returns false when the handle was already unknown. */
  public async delete(id: string): Promise<boolean> {
    await this.load();
    if (!isStoreFileId(id)) {
      return false;
    }
    const record = this.records.get(id);
    if (!record) {
      return false;
    }
    this.records.delete(id);
    await this.removeUnreferencedBlob(record.sha256);
    await this.persistIndex();
    return true;
  }

  /**
   * Drops every expired handle and the blobs nothing references any more.
   * Runs at construction time (first `load`), on a timer, and before listing.
   */
  public async sweep(): Promise<number> {
    await this.load();
    const now = Date.now();
    const expired = [...this.records.values()].filter((record) => record.expireTimeMs <= now);
    if (expired.length === 0) {
      return 0;
    }
    for (const record of expired) {
      this.records.delete(record.id);
    }
    for (const record of expired) {
      await this.removeUnreferencedBlob(record.sha256);
    }
    await this.persistIndex();
    return expired.length;
  }

  private requireLive(id: string): StoredFileRecord {
    if (!isStoreFileId(id)) {
      throw FileStoreError.invalidId(id);
    }
    const record = this.records.get(id);
    if (!record) {
      throw FileStoreError.notFound(id);
    }
    if (record.expireTimeMs <= Date.now()) {
      this.records.delete(id);
      void this.persistIndex().catch(() => undefined);
      throw FileStoreError.expired(id);
    }
    return record;
  }

  private totalBytes(): number {
    let total = 0;
    const countedDigests = new Set<string>();
    for (const record of this.records.values()) {
      if (countedDigests.has(record.sha256)) {
        continue;
      }
      countedDigests.add(record.sha256);
      total += record.sizeBytes;
    }
    return total;
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;

    const { records, indexEntryCount } = await this.disk.open();
    const now = Date.now();
    for (const record of records) {
      if (record.expireTimeMs > now) {
        this.records.set(record.id, record);
      }
    }

    // Startup sweep: expired handles never entered the map above, so this only
    // has to reclaim the blobs they were holding.
    await this.disk.removeOrphanBlobs(this.referencedDigests());
    if (indexEntryCount !== this.records.size) {
      await this.persistIndex();
    }
  }

  private referencedDigests(): Set<string> {
    return new Set([...this.records.values()].map((record) => record.sha256));
  }

  private async removeUnreferencedBlob(sha256: string): Promise<void> {
    if (!this.referencedDigests().has(sha256)) {
      await this.disk.removeBlob(sha256);
    }
  }

  private persistIndex(): Promise<void> {
    return this.disk.persistIndex([...this.records.values()]);
  }
}

function sanitizeDisplayName(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  // Display names are metadata only — they never build a path — but dropping
  // control characters and separators keeps them safe to echo back.
  const cleaned = [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join('')
    .replace(/[/\\]/gu, '_')
    .trim()
    .slice(0, 256);
  return cleaned || undefined;
}
