/**
 * Shared vocabulary for the local proxy file store.
 *
 * The provider surface this proxy speaks to (`v1internal` on `cloudcode-pa`)
 * has no file plane at all: no upload method, no `files/*` resource, and no
 * `fileUri` fetch. Everything here is therefore a *local* content-addressed
 * store whose only job is to let a client upload bytes once and reference them
 * by handle afterwards. Handles are expanded back into `inlineData` parts on
 * the way upstream, so the provider still receives the same bytes it always
 * did — the saving is on the client link and in conversation bookkeeping, not
 * in provider-side storage or tokens.
 */

/** Purposes the OpenAI files surface can genuinely serve through this proxy. */
export const SUPPORTED_OPENAI_FILE_PURPOSES = ['user_data', 'vision', 'assistants_input'] as const;

export type FileStoreErrorCode =
  | 'invalid_id'
  | 'not_found'
  | 'expired'
  | 'empty_file'
  | 'file_too_large'
  | 'store_full';

/**
 * Every failure the store raises, carrying the HTTP status each protocol
 * adapter should reuse. `413` for the two size ceilings is the shape the brief
 * asks for; adapters translate the status into their own error envelope.
 */
export class FileStoreError extends Error {
  public readonly code: FileStoreErrorCode;
  public readonly httpStatus: number;

  constructor(code: FileStoreErrorCode, message: string, httpStatus: number) {
    super(message);
    this.name = 'FileStoreError';
    this.code = code;
    this.httpStatus = httpStatus;
  }

  public static invalidId(id: string): FileStoreError {
    return new FileStoreError(
      'invalid_id',
      `File handle '${id}' was never issued by this proxy`,
      400,
    );
  }

  public static notFound(id: string): FileStoreError {
    return new FileStoreError(
      'not_found',
      `File handle '${id}' was never issued by this proxy`,
      404,
    );
  }

  public static expired(id: string): FileStoreError {
    return new FileStoreError(
      'expired',
      `File handle '${id}' has expired and its content is no longer stored`,
      404,
    );
  }

  public static empty(): FileStoreError {
    return new FileStoreError('empty_file', 'Uploaded file is empty', 400);
  }

  public static tooLarge(bytes: number, limit: number): FileStoreError {
    return new FileStoreError(
      'file_too_large',
      `Uploaded file is ${bytes} bytes which exceeds the ${limit} byte per-file limit`,
      413,
    );
  }

  public static storeFull(limit: number): FileStoreError {
    return new FileStoreError(
      'store_full',
      `Local file store is full; the total ceiling is ${limit} bytes. Delete files and retry.`,
      413,
    );
  }
}

/** One stored upload. Content lives beside the index, addressed by `sha256`. */
export interface StoredFileRecord {
  /** Opaque 32-hex handle derived from the content digest. Never client supplied. */
  id: string;
  /** Lowercase hex sha256 of the stored bytes. */
  sha256: string;
  /** Byte length of the stored content. */
  sizeBytes: number;
  /** Effective MIME type: the sniffed one whenever sniffing recognised the bytes. */
  mimeType: string;
  /** What the client claimed at upload time, retained for diagnostics. */
  declaredMimeType?: string;
  /** What the magic bytes say, when they say anything. */
  sniffedMimeType?: string;
  /** Client supplied name. Never used to build a filesystem path. */
  displayName: string;
  /** OpenAI upload purpose, when the upload came in through that surface. */
  purpose?: string;
  /** Epoch millis. */
  createTimeMs: number;
  /** Epoch millis, refreshed when identical content is uploaded again. */
  updateTimeMs: number;
  /** Epoch millis after which the handle resolves to an `expired` error. */
  expireTimeMs: number;
}

export interface FileStoreOptions {
  /** Absolute directory that holds `index.json`, `blobs/` and `tmp/`. */
  rootDirectory?: string;
  /** Per-file ceiling in bytes. */
  maxFileBytes?: number;
  /** Whole-store ceiling in bytes. */
  maxStoreBytes?: number;
  /** Handle lifetime in milliseconds. */
  ttlMs?: number;
  /** Periodic sweep interval in milliseconds; `0` disables the timer. */
  sweepIntervalMs?: number;
}

export interface PutFileInput {
  bytes: Buffer;
  declaredMimeType?: string;
  displayName?: string;
  purpose?: string;
}

export interface ListFilesOptions {
  limit?: number;
  pageToken?: string;
}

export interface ListFilesResult {
  files: StoredFileRecord[];
  nextPageToken?: string;
}

/**
 * Defaults sized for an Electron app's disk budget rather than for a hosted
 * service: 20 MiB per file keeps a single upload inside the multipart ceiling
 * the proxy already enforces (`OPENAI_INLINE_MEDIA_BYTES_LIMIT`, 14 MiB, is the
 * inline path; uploads are allowed a little more headroom), and 512 MiB total
 * is a bounded, user-visible amount of state under `userData`.
 */
export const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_STORE_BYTES = 512 * 1024 * 1024;
/** 48 hours, matching the lifetime Google documents for its own Files API. */
export const DEFAULT_FILE_TTL_MS = 48 * 60 * 60 * 1000;
export const DEFAULT_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

const FILE_ID_PATTERN = /^[0-9a-f]{32}$/u;

/**
 * Accepts the handle spellings each surface hands back and returns the bare
 * store id. A client-supplied string can only ever be matched against this
 * pattern; it never reaches the filesystem, so `../` and friends are rejected
 * as "never issued" rather than being sanitised.
 */
export function parseFileHandle(handle: string): string | null {
  const trimmed = handle.trim();
  if (!trimmed) {
    return null;
  }

  const withoutUri = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\//iu, '');
  const withoutResource = withoutUri
    .replace(/^\/?(?:v1beta\/)?files\//iu, '')
    .replace(/^file[-_]/iu, '');
  const candidate = withoutResource.toLowerCase();
  return FILE_ID_PATTERN.test(candidate) ? candidate : null;
}

export function isStoreFileId(value: string): boolean {
  return FILE_ID_PATTERN.test(value);
}
