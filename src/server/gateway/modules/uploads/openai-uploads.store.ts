import path from 'path';

import { DurableRecordStore } from '@/shared/persistence/durable-record-store';
import {
  isDurableStoreTestEnvironment,
  readPositiveIntegerEnv,
} from '@/shared/persistence/durable-store-settings';
import { getProxyStateDir } from '@/shared/platform/paths';
import {
  DEFAULT_OPENAI_UPLOAD_MAX_PENDING,
  DEFAULT_OPENAI_UPLOAD_TTL_MS,
  OPENAI_UPLOAD_ID_PREFIX,
  OPENAI_UPLOAD_PART_ID_PREFIX,
  OPENAI_UPLOADS_FILENAME,
  type OpenAIUploadsStoreOptions,
  type PendingOpenAIUpload,
  type PendingOpenAIUploadPart,
  type PersistedOpenAIUpload,
  type PersistedOpenAIUploadPart,
} from './openai-uploads.types';

const BASE64_CANONICAL_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function isCanonicalBase64(value: string): boolean {
  if (typeof value !== 'string' || !value) {
    return false;
  }
  if (value.length % 4 !== 0 || !BASE64_CANONICAL_PATTERN.test(value)) {
    return false;
  }
  const buffer = Buffer.from(value, 'base64');
  return buffer.length > 0 && buffer.toString('base64') === value;
}

export function defaultOpenAIUploadsStoreOptions(): OpenAIUploadsStoreOptions {
  return {
    filePath: isDurableStoreTestEnvironment()
      ? undefined
      : path.join(getProxyStateDir(), OPENAI_UPLOADS_FILENAME),
    maxPendingUploads: readPositiveIntegerEnv(
      'AGM_UPLOADS_MAX_PENDING',
      readPositiveIntegerEnv('AGM_UPLOADS_MAX_ENTRIES', DEFAULT_OPENAI_UPLOAD_MAX_PENDING),
    ),
    ttlMs: readPositiveIntegerEnv('AGM_UPLOADS_TTL_MS', DEFAULT_OPENAI_UPLOAD_TTL_MS),
  };
}

/**
 * Bounded, crash-safe store for incomplete OpenAI upload sessions.
 *
 * Implements the repository's durable-or-in-memory convention: given a `filePath`
 * it persists sessions atomically through `DurableRecordStore`, surviving process
 * restarts. When `filePath` is omitted (such as in unit test environments), it
 * operates as an isolated in-memory store.
 */
export class OpenAIUploadsStore {
  private readonly records: DurableRecordStore<PersistedOpenAIUpload>;
  private readonly maxPendingUploads: number;
  private readonly ttlMs: number;

  public constructor(options: OpenAIUploadsStoreOptions = {}) {
    this.maxPendingUploads = options.maxPendingUploads ?? DEFAULT_OPENAI_UPLOAD_MAX_PENDING;
    this.ttlMs = options.ttlMs ?? DEFAULT_OPENAI_UPLOAD_TTL_MS;
    this.records = new DurableRecordStore<PersistedOpenAIUpload>({
      filePath: options.filePath,
      maxEntries: this.maxPendingUploads,
      ttlMs: this.ttlMs * 2,
      revive: revivePersistedOpenAIUpload,
    });
  }

  public get(id: string, now: number = Date.now()): PendingOpenAIUpload | null {
    if (!id.startsWith(OPENAI_UPLOAD_ID_PREFIX)) {
      return null;
    }
    const persisted = this.records.get(id, now);
    if (!persisted) {
      return null;
    }
    return toPendingOpenAIUpload(persisted);
  }

  public save(upload: PendingOpenAIUpload, now: number = Date.now()): void {
    const persisted = toPersistedOpenAIUpload(upload);
    this.records.set(upload.id, persisted, now);
  }

  public delete(id: string): boolean {
    return this.records.delete(id);
  }

  public clear(): void {
    this.records.clear();
  }

  public entries(now: number = Date.now()): PendingOpenAIUpload[] {
    return this.records
      .entries(now)
      .map((entry) => entry.value)
      .map(toPendingOpenAIUpload);
  }

  public get size(): number {
    return this.records.size;
  }

  public flush(): Promise<void> {
    return this.records.flush();
  }
}

export function revivePersistedOpenAIUpload(value: unknown): PersistedOpenAIUpload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const id = Reflect.get(value, 'id');
  const bytes = Reflect.get(value, 'bytes');
  const filename = Reflect.get(value, 'filename');
  const purpose = Reflect.get(value, 'purpose');
  const mimeType = Reflect.get(value, 'mimeType');
  const createdAtMs = Reflect.get(value, 'createdAtMs');
  const expiresAtMs = Reflect.get(value, 'expiresAtMs');
  const rawParts = Reflect.get(value, 'parts');

  if (
    typeof id !== 'string' ||
    !id.startsWith(OPENAI_UPLOAD_ID_PREFIX) ||
    typeof bytes !== 'number' ||
    !Number.isSafeInteger(bytes) ||
    bytes <= 0 ||
    typeof filename !== 'string' ||
    !filename ||
    typeof purpose !== 'string' ||
    !purpose ||
    typeof mimeType !== 'string' ||
    !mimeType ||
    typeof createdAtMs !== 'number' ||
    !Number.isFinite(createdAtMs) ||
    typeof expiresAtMs !== 'number' ||
    !Number.isFinite(expiresAtMs) ||
    !Array.isArray(rawParts)
  ) {
    return null;
  }

  const parts: PersistedOpenAIUploadPart[] = [];
  let totalPartBytes = 0;
  for (const rawPart of rawParts) {
    if (typeof rawPart !== 'object' || rawPart === null || Array.isArray(rawPart)) {
      return null;
    }
    const partId = Reflect.get(rawPart, 'id');
    const bytesBase64 = Reflect.get(rawPart, 'bytesBase64');
    const partCreatedAtMs = Reflect.get(rawPart, 'createdAtMs');

    if (
      typeof partId !== 'string' ||
      !partId.startsWith(OPENAI_UPLOAD_PART_ID_PREFIX) ||
      typeof bytesBase64 !== 'string' ||
      !isCanonicalBase64(bytesBase64) ||
      typeof partCreatedAtMs !== 'number' ||
      !Number.isFinite(partCreatedAtMs)
    ) {
      return null;
    }

    const partBuffer = Buffer.from(bytesBase64, 'base64');
    totalPartBytes += partBuffer.length;
    if (totalPartBytes > bytes) {
      return null;
    }

    parts.push({
      id: partId,
      bytesBase64,
      createdAtMs: partCreatedAtMs,
    });
  }

  return {
    id,
    bytes,
    filename,
    purpose,
    mimeType,
    createdAtMs,
    expiresAtMs,
    parts,
  };
}

export function toPendingOpenAIUpload(persisted: PersistedOpenAIUpload): PendingOpenAIUpload {
  const parts = new Map<string, PendingOpenAIUploadPart>();
  for (const part of persisted.parts) {
    parts.set(part.id, {
      id: part.id,
      bytes: Buffer.from(part.bytesBase64, 'base64'),
      createdAtMs: part.createdAtMs,
    });
  }
  return {
    id: persisted.id,
    bytes: persisted.bytes,
    filename: persisted.filename,
    purpose: persisted.purpose,
    mimeType: persisted.mimeType,
    createdAtMs: persisted.createdAtMs,
    expiresAtMs: persisted.expiresAtMs,
    parts,
  };
}

export function toPersistedOpenAIUpload(upload: PendingOpenAIUpload): PersistedOpenAIUpload {
  return {
    id: upload.id,
    bytes: upload.bytes,
    filename: upload.filename,
    purpose: upload.purpose,
    mimeType: upload.mimeType,
    createdAtMs: upload.createdAtMs,
    expiresAtMs: upload.expiresAtMs,
    parts: [...upload.parts.values()].map((part) => ({
      id: part.id,
      bytesBase64: part.bytes.toString('base64'),
      createdAtMs: part.createdAtMs,
    })),
  };
}
