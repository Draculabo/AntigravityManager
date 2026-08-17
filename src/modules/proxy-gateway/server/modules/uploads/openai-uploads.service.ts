import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { FileContentStore } from '../files/file-content-store.service';
import type { StoredFileRecord } from '../files/file-store.types';
import { normalizeOpenAIPurpose } from '../files/openai-file-resource';
import {
  DEFAULT_OPENAI_UPLOAD_MAX_PENDING,
  DEFAULT_OPENAI_UPLOAD_SWEEP_INTERVAL_MS,
  DEFAULT_OPENAI_UPLOAD_TTL_MS,
  OPENAI_UPLOAD_ID_PREFIX,
  OPENAI_UPLOAD_PART_ID_PREFIX,
  OpenAIUploadError,
  type PendingOpenAIUpload,
  type PendingOpenAIUploadPart,
} from './openai-uploads.types';

/**
 * Holds incomplete OpenAI uploads in memory until their parts are explicitly
 * completed into the shared local file store. The periodic sweep and every
 * lookup discard expired part buffers, so an abandoned request has no durable
 * footprint and cannot consume memory indefinitely; the pending-session count
 * is capped for the same reason.
 */
@Injectable()
export class OpenAIUploadsService {
  private readonly uploads = new Map<string, PendingOpenAIUpload>();
  private readonly sweepTimer: NodeJS.Timeout;

  public constructor(@Inject(FileContentStore) private readonly fileStore: FileContentStore) {
    this.sweepTimer = setInterval(() => {
      this.sweep();
    }, DEFAULT_OPENAI_UPLOAD_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  public onModuleDestroy(): void {
    clearInterval(this.sweepTimer);
    this.uploads.clear();
  }

  public create(input: unknown): PendingOpenAIUpload {
    this.sweep();

    const body = requireObject(input, 'body');
    const declaredBytes = requirePositiveInteger(body.bytes, 'bytes');
    const { maxFileBytes } = this.fileStore.getLimits();
    if (declaredBytes > maxFileBytes) {
      throw new OpenAIUploadError(
        'file_too_large',
        `Upload declares ${declaredBytes} bytes which exceeds the ${maxFileBytes} byte per-file limit`,
        413,
        'bytes',
      );
    }
    if (this.uploads.size >= DEFAULT_OPENAI_UPLOAD_MAX_PENDING) {
      throw OpenAIUploadError.tooManyPending(DEFAULT_OPENAI_UPLOAD_MAX_PENDING);
    }

    const filename = requireNonEmptyString(body.filename, 'filename');
    const mimeType = requireNonEmptyString(body.mime_type, 'mime_type');
    const purpose = normalizeOpenAIPurpose(
      typeof body.purpose === 'string' ? body.purpose : undefined,
    );
    const now = Date.now();
    const upload: PendingOpenAIUpload = {
      id: `${OPENAI_UPLOAD_ID_PREFIX}${newId()}`,
      bytes: declaredBytes,
      filename,
      purpose,
      mimeType,
      createdAtMs: now,
      expiresAtMs: now + DEFAULT_OPENAI_UPLOAD_TTL_MS,
      parts: new Map(),
    };
    this.uploads.set(upload.id, upload);
    return upload;
  }

  public addPart(id: string, bytes: Buffer): PendingOpenAIUploadPart {
    const upload = this.requirePending(id);
    if (bytes.length === 0) {
      throw OpenAIUploadError.invalid('A part must contain at least one byte', 'data');
    }

    const receivedBytes = [...upload.parts.values()].reduce(
      (total, part) => total + part.bytes.length,
      0,
    );
    if (receivedBytes + bytes.length > upload.bytes) {
      throw new OpenAIUploadError(
        'byte_count_exceeded',
        `Upload declares ${upload.bytes} bytes but accepting this part would retain ${receivedBytes + bytes.length}`,
        400,
        'data',
      );
    }

    const part: PendingOpenAIUploadPart = {
      id: `${OPENAI_UPLOAD_PART_ID_PREFIX}${newId()}`,
      bytes: Buffer.from(bytes),
      createdAtMs: Date.now(),
    };
    upload.parts.set(part.id, part);
    return part;
  }

  public async complete(id: string, input: unknown): Promise<StoredFileRecord> {
    const upload = this.requirePending(id);
    const partIds = requirePartIds(input);
    const parts = partIds.map((partId) => {
      const part = upload.parts.get(partId);
      if (!part) {
        throw new OpenAIUploadError(
          'invalid_part',
          `Part '${partId}' does not belong to upload '${id}'`,
          400,
          'part_ids',
        );
      }
      return part;
    });
    const bytes = Buffer.concat(parts.map((part) => part.bytes));
    if (bytes.length !== upload.bytes) {
      throw OpenAIUploadError.byteCountMismatch(upload.bytes, bytes.length);
    }

    const file = await this.fileStore.put({
      bytes,
      declaredMimeType: upload.mimeType,
      displayName: upload.filename,
      purpose: upload.purpose,
    });
    // The completed bytes now live in the file store; the session and its
    // part buffers have no further reason to be held in memory.
    this.uploads.delete(id);
    return file;
  }

  public cancel(id: string): PendingOpenAIUpload {
    const upload = this.requirePending(id);
    this.uploads.delete(id);
    return upload;
  }

  private requirePending(id: string): PendingOpenAIUpload {
    const upload = this.uploads.get(id);
    if (!upload) {
      throw OpenAIUploadError.notFound(id);
    }
    if (upload.expiresAtMs <= Date.now()) {
      this.uploads.delete(id);
      throw OpenAIUploadError.expired(id);
    }
    return upload;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, upload] of this.uploads.entries()) {
      if (upload.expiresAtMs <= now) {
        this.uploads.delete(id);
      }
    }
  }
}

function requireObject(value: unknown, param: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw OpenAIUploadError.invalid(`${param} must be a JSON object`, param);
  }
  return value as Record<string, unknown>;
}

function requirePositiveInteger(value: unknown, param: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw OpenAIUploadError.invalid(`${param} must be a positive integer`, param);
  }
  return value;
}

function requireNonEmptyString(value: unknown, param: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw OpenAIUploadError.invalid(`${param} is required`, param);
  }
  return value.trim();
}

function requirePartIds(input: unknown): string[] {
  const body = requireObject(input, 'body');
  if (!Array.isArray(body.part_ids) || body.part_ids.length === 0) {
    throw OpenAIUploadError.invalid('part_ids must be a non-empty array', 'part_ids');
  }
  const partIds = body.part_ids.map((partId) => {
    if (typeof partId !== 'string' || !partId.trim()) {
      throw OpenAIUploadError.invalid('part_ids must contain non-empty strings', 'part_ids');
    }
    return partId.trim();
  });
  if (new Set(partIds).size !== partIds.length) {
    throw OpenAIUploadError.invalid('part_ids must not repeat a part', 'part_ids');
  }
  return partIds;
}

function newId(): string {
  return randomUUID().replace(/-/gu, '');
}
