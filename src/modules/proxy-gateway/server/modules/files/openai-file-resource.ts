import {
  FileStoreError,
  SUPPORTED_OPENAI_FILE_PURPOSES,
  type StoredFileRecord,
} from './file-store.types';
import { FileUploadError } from './file-upload-request';

export const OPENAI_FILE_ID_PREFIX = 'file-';

export interface OpenAIFileObject {
  id: string;
  object: 'file';
  bytes: number;
  created_at: number;
  expires_at: number;
  filename: string;
  purpose: string;
  status: 'processed';
}

export function toOpenAIFileObject(record: StoredFileRecord): OpenAIFileObject {
  return {
    id: `${OPENAI_FILE_ID_PREFIX}${record.id}`,
    object: 'file',
    bytes: record.sizeBytes,
    created_at: Math.floor(record.createTimeMs / 1000),
    expires_at: Math.floor(record.expireTimeMs / 1000),
    filename: record.displayName,
    purpose: record.purpose ?? 'user_data',
    status: 'processed',
  };
}

/**
 * Purposes this proxy can genuinely serve.
 *
 * `fine-tune`, `batch`, `evals` and the Assistants output purposes are refused
 * at upload rather than accepted and left quietly useless: there is no
 * fine-tuning, batching or Assistants runtime behind this proxy, so a file
 * stored under those purposes could never be used for anything.
 */
export function normalizeOpenAIPurpose(value: string | undefined): string {
  const purpose = (value ?? '').trim();
  if (!purpose) {
    throw new FileUploadError('purpose is required', 'purpose');
  }
  if (!(SUPPORTED_OPENAI_FILE_PURPOSES as readonly string[]).includes(purpose)) {
    throw new FileUploadError(
      `purpose '${purpose}' is not available through this proxy; supported purposes are ${SUPPORTED_OPENAI_FILE_PURPOSES.join(', ')}`,
      'purpose',
    );
  }
  return purpose;
}

export interface OpenAIErrorEnvelope {
  error: {
    code: string | null;
    message: string;
    param: string | null;
    type: string;
  };
}

export function openAIFileErrorResponse(error: unknown): {
  statusCode: number;
  body: OpenAIErrorEnvelope;
} {
  const statusCode = resolveStatus(error);
  const param = (error as { param?: unknown })?.param;
  return {
    statusCode,
    body: {
      error: {
        code: resolveCode(error, statusCode),
        message: error instanceof Error ? error.message : 'File request failed',
        param: typeof param === 'string' ? param : null,
        type: statusCode >= 500 ? 'server_error' : 'invalid_request_error',
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

function resolveCode(error: unknown, statusCode: number): string | null {
  if (error instanceof FileStoreError) {
    return error.code;
  }
  if (statusCode === 404) {
    return 'file_not_found';
  }
  if (statusCode === 413) {
    return 'file_too_large';
  }
  return null;
}
