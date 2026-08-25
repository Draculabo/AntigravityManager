import { FileStoreError, type StoredFileRecord } from './file-store.types';
import { FileUploadError } from './file-upload-request';

/**
 * Shapes for Google's documented `File` resource.
 *
 * `state` is always `ACTIVE`: there is no processing step behind this store, so
 * inventing a `PROCESSING` phase we would never leave would be a lie the client
 * has to poll against.
 */
export interface GeminiFileResource {
  name: string;
  displayName: string;
  mimeType: string;
  sizeBytes: string;
  createTime: string;
  updateTime: string;
  expirationTime: string;
  sha256Hash: string;
  uri: string;
  state: 'ACTIVE';
  source: 'UPLOADED';
}

export function toGeminiFileResource(
  record: StoredFileRecord,
  baseUrl: string,
): GeminiFileResource {
  return {
    name: `files/${record.id}`,
    displayName: record.displayName,
    mimeType: record.mimeType,
    sizeBytes: String(record.sizeBytes),
    createTime: new Date(record.createTimeMs).toISOString(),
    updateTime: new Date(record.updateTimeMs).toISOString(),
    expirationTime: new Date(record.expireTimeMs).toISOString(),
    // Google encodes the digest bytes as base64, not hex.
    sha256Hash: Buffer.from(record.sha256, 'hex').toString('base64'),
    uri: `${baseUrl}/v1beta/files/${record.id}`,
    state: 'ACTIVE',
    source: 'UPLOADED',
  };
}

export interface GeminiErrorEnvelope {
  error: {
    code: number;
    message: string;
    status: string;
  };
}

const GOOGLE_STATUS_BY_HTTP: Record<number, string> = {
  400: 'INVALID_ARGUMENT',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  413: 'FAILED_PRECONDITION',
  429: 'RESOURCE_EXHAUSTED',
  500: 'INTERNAL',
  501: 'UNIMPLEMENTED',
};

export function geminiFileErrorResponse(error: unknown): {
  statusCode: number;
  body: GeminiErrorEnvelope;
} {
  const statusCode = resolveStatus(error);
  return {
    statusCode,
    body: {
      error: {
        code: statusCode,
        message: error instanceof Error ? error.message : 'File request failed',
        status: GOOGLE_STATUS_BY_HTTP[statusCode] ?? 'UNKNOWN',
      },
    },
  };
}

function resolveStatus(error: unknown): number {
  if (error instanceof FileStoreError || error instanceof FileUploadError) {
    return error.httpStatus;
  }
  const status = (error as { httpStatus?: unknown })?.httpStatus;
  return typeof status === 'number' ? status : 500;
}

/**
 * The `metadata` part of Google's multipart upload form, e.g.
 * `{"file": {"display_name": "…"}}`. Absent or unparsable metadata is not an
 * error — the filename from the file part is a perfectly good display name.
 */
export function readGeminiUploadDisplayName(fields: Record<string, string>): string | undefined {
  const raw = fields.metadata ?? fields.file ?? fields.Metadata;
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const file = (parsed.file ?? parsed) as Record<string, unknown>;
    const displayName = file.display_name ?? file.displayName;
    return typeof displayName === 'string' && displayName.trim() ? displayName.trim() : undefined;
  } catch {
    return undefined;
  }
}
