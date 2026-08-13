import { FileStoreError, type StoredFileRecord } from './file-store.types';
import { FileUploadError } from './file-upload-request';

export const ANTHROPIC_FILE_ID_PREFIX = 'file_';
export const ANTHROPIC_FILES_BETA = 'files-api-2025-04-14';

export interface AnthropicFileObject {
  id: string;
  type: 'file';
  filename: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  downloadable: boolean;
}

export function toAnthropicFileObject(record: StoredFileRecord): AnthropicFileObject {
  return {
    id: `${ANTHROPIC_FILE_ID_PREFIX}${record.id}`,
    type: 'file',
    filename: record.displayName,
    mime_type: record.mimeType,
    size_bytes: record.sizeBytes,
    created_at: new Date(record.createTimeMs).toISOString(),
    // Everything in this store is our own copy of bytes the client uploaded, so
    // there is never a reason to refuse to hand them back.
    downloadable: true,
  };
}

/**
 * The Files API is beta-gated at Anthropic, and this proxy requires the header
 * too — deliberately.
 *
 * The requirement does double duty here: `/v1/files` is the same path on the
 * OpenAI and Anthropic surfaces, so the beta header is also how a request says
 * which dialect it wants. Accepting Anthropic-shaped calls without it would
 * mean guessing, and guessing wrong returns an OpenAI-shaped body to an
 * Anthropic SDK. See the surface-selection note in the server README.
 */
export function requireAnthropicFilesBeta(betaHeader: string | undefined): void {
  const declared = (betaHeader ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!declared.includes(ANTHROPIC_FILES_BETA)) {
    throw new AnthropicFilesBetaError();
  }
}

export class AnthropicFilesBetaError extends Error {
  public readonly httpStatus = 400;

  constructor() {
    super(
      `The Files API requires the '${ANTHROPIC_FILES_BETA}' beta. Send 'anthropic-beta: ${ANTHROPIC_FILES_BETA}'.`,
    );
    this.name = 'AnthropicFilesBetaError';
  }
}

export interface AnthropicErrorEnvelope {
  type: 'error';
  error: {
    type: string;
    message: string;
  };
  request_id?: string;
}

const ANTHROPIC_ERROR_TYPE_BY_STATUS: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  500: 'api_error',
};

export function anthropicFileErrorResponse(
  error: unknown,
  requestId?: string,
): { statusCode: number; body: AnthropicErrorEnvelope } {
  const statusCode = resolveStatus(error);
  return {
    statusCode,
    body: {
      type: 'error',
      error: {
        type: ANTHROPIC_ERROR_TYPE_BY_STATUS[statusCode] ?? 'api_error',
        message: error instanceof Error ? error.message : 'File request failed',
      },
      ...(requestId ? { request_id: requestId } : {}),
    },
  };
}

function resolveStatus(error: unknown): number {
  if (
    error instanceof FileStoreError ||
    error instanceof FileUploadError ||
    error instanceof AnthropicFilesBetaError
  ) {
    return error.httpStatus;
  }
  const status = (error as { httpStatus?: unknown })?.httpStatus;
  return typeof status === 'number' ? status : 500;
}
