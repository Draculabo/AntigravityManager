import { FileStoreError } from '../files/file-store.types';
import { FileUploadError } from '../files/file-upload-request';
import type { PendingOpenAIUpload, PendingOpenAIUploadPart } from './openai-uploads.types';
import { OpenAIUploadError } from './openai-uploads.types';

export interface OpenAIUploadObject {
  id: string;
  object: 'upload';
  bytes: number;
  created_at: number;
  expires_at: number;
  filename: string;
  purpose: string;
  mime_type: string;
  status: 'pending' | 'cancelled';
}

export interface OpenAIUploadPartObject {
  id: string;
  object: 'upload.part';
  created_at: number;
  upload_id: string;
}

export function toOpenAIUploadObject(
  upload: PendingOpenAIUpload,
  status: OpenAIUploadObject['status'] = 'pending',
): OpenAIUploadObject {
  return {
    id: upload.id,
    object: 'upload',
    bytes: upload.bytes,
    created_at: toSeconds(upload.createdAtMs),
    expires_at: toSeconds(upload.expiresAtMs),
    filename: upload.filename,
    purpose: upload.purpose,
    mime_type: upload.mimeType,
    status,
  };
}

export function toOpenAIUploadPartObject(
  uploadId: string,
  part: PendingOpenAIUploadPart,
): OpenAIUploadPartObject {
  return {
    id: part.id,
    object: 'upload.part',
    created_at: toSeconds(part.createdAtMs),
    upload_id: uploadId,
  };
}

export function openAIUploadErrorResponse(error: unknown): {
  statusCode: number;
  body: { error: { code: string | null; message: string; param: string | null; type: string } };
} {
  const statusCode = resolveStatus(error);
  return {
    statusCode,
    body: {
      error: {
        code: resolveCode(error),
        message: error instanceof Error ? error.message : 'Upload request failed',
        param: resolveParam(error),
        type: statusCode >= 500 ? 'server_error' : 'invalid_request_error',
      },
    },
  };
}

function resolveStatus(error: unknown): number {
  if (
    error instanceof OpenAIUploadError ||
    error instanceof FileStoreError ||
    error instanceof FileUploadError
  ) {
    return error.httpStatus;
  }
  const status = (error as { httpStatus?: unknown })?.httpStatus;
  return typeof status === 'number' ? status : 500;
}

function resolveCode(error: unknown): string | null {
  if (error instanceof OpenAIUploadError || error instanceof FileStoreError) {
    return error.code;
  }
  if (error instanceof FileUploadError) {
    return 'invalid_request';
  }
  return null;
}

function resolveParam(error: unknown): string | null {
  if (error instanceof OpenAIUploadError) {
    return error.param;
  }
  if (error instanceof FileUploadError) {
    return error.param;
  }
  return null;
}

function toSeconds(milliseconds: number): number {
  return Math.floor(milliseconds / 1000);
}
