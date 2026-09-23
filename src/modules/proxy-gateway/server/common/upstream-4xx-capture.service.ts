import { Injectable, Logger } from '@nestjs/common';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isObjectLike, isPlainObject, isString } from 'lodash-es';
import { getAgentDir } from '@/shared/platform/paths';
import { readPositiveIntegerEnv } from '@/shared/persistence/durable-store-settings';
import { sanitizeObject } from '@/shared/security/sensitiveDataMasking';
import {
  getUpstreamCaptureContext,
  isUpstream4xxCaptureEnabled,
  snapshotCapturePayload,
  type UpstreamCaptureContext,
} from './upstream-capture-context';

const CAPTURE_DIRECTORY = 'captures';
const CAPTURE_LIMIT = 50;
const CAPTURE_MAX_BYTES = 1024 * 1024;
const CAPTURE_DIRECTORY_MAX_BYTES = CAPTURE_LIMIT * CAPTURE_MAX_BYTES;
const CAPTURE_DIRECTORY_MAX_BYTES_ENV = 'AGM_UPSTREAM_4XX_CAPTURE_MAX_DIRECTORY_BYTES';
const CAPTURE_SUMMARY_FIELD_MAX_LENGTH = 1024;
const MAX_PENDING_CAPTURES = 4;
const SENSITIVE_QUERY_PARAM_PATTERN =
  /([?&](?:api[_-]?key|key|access[_-]?token|refresh[_-]?token|id[_-]?token|bearer[_-]?token|token|authorization|auth|secret|client[_-]?secret|session(?:[_-]?id)?|cookie|credential(?:s)?|code)=)[^&#]*/giu;

interface CaptureMetadata {
  captured_at: string;
  client_visible_model: string | null;
  mapped_upstream_model: string | null;
  upstream_endpoint: string;
}

interface CaptureFile {
  filePath: string;
  modifiedAt: number;
  size: number;
}

export interface Upstream4xxCaptureInput {
  endpoint: string;
  status?: number;
  upstreamErrorBody: unknown;
  upstreamRequest: unknown;
}

/**
 * Writes a redacted request/rejection pair for upstream 4xx diagnosis when explicitly enabled.
 * Capture is diagnostic-only: any filesystem error is logged and deliberately swallowed so it
 * can never turn the caller's upstream 4xx into a 5xx.
 */
@Injectable()
export class Upstream4xxCaptureService {
  private static captureQueue: Promise<void> = Promise.resolve();
  private static pendingCaptureCount = 0;
  private readonly logger = new Logger(Upstream4xxCaptureService.name);

  async capture(input: Upstream4xxCaptureInput): Promise<void> {
    const status = input.status;
    if (!isUpstream4xxCaptureEnabled() || !isClientErrorStatus(status)) {
      return;
    }
    if (Upstream4xxCaptureService.pendingCaptureCount >= MAX_PENDING_CAPTURES) {
      this.logger.warn('Skipped upstream 4xx capture because the diagnostic queue is full.');
      return;
    }

    const context = snapshotCaptureContext(getUpstreamCaptureContext());
    const captureInput: Upstream4xxCaptureInput = {
      endpoint: redactSensitiveQueryParams(snapshotCaptureText(input.endpoint)) ?? '',
      status,
      upstreamErrorBody: snapshotCapturePayload(input.upstreamErrorBody),
      upstreamRequest: snapshotCapturePayload(input.upstreamRequest),
    };
    Upstream4xxCaptureService.pendingCaptureCount += 1;
    const scheduledCapture = Upstream4xxCaptureService.captureQueue.then(() =>
      this.writeCapture(captureInput, context, status),
    );
    Upstream4xxCaptureService.captureQueue = scheduledCapture.catch(() => undefined);
    try {
      await scheduledCapture;
    } finally {
      Upstream4xxCaptureService.pendingCaptureCount -= 1;
    }
  }

  private async writeCapture(
    input: Upstream4xxCaptureInput,
    context: UpstreamCaptureContext | undefined,
    status: number,
  ): Promise<void> {
    try {
      const captureDirectory = path.join(getAgentDir(), CAPTURE_DIRECTORY);
      await fs.mkdir(captureDirectory, { mode: 0o700, recursive: true });
      if (process.platform !== 'win32') {
        await fs.chmod(captureDirectory, 0o700);
      }
      const capturedAt = new Date().toISOString();
      const metadata: CaptureMetadata = {
        captured_at: capturedAt,
        client_visible_model: findClientModel(
          context?.clientRequest.body,
          context?.clientRequest.endpoint,
        ),
        mapped_upstream_model: findModel(input.upstreamRequest),
        upstream_endpoint: redactSensitiveQueryParams(input.endpoint) ?? '',
      };
      const document = sanitizeObject({
        client_request: {
          body: context?.clientRequest.body,
          endpoint: redactSensitiveQueryParams(context?.clientRequest.endpoint),
          headers: context?.clientRequest.headers ?? {},
        },
        metadata,
        upstream_request: input.upstreamRequest,
        upstream_response: {
          error_body: input.upstreamErrorBody,
          status,
        },
      });
      const filename = `${capturedAt.replace(/[:.]/gu, '-')}-${randomUUID()}.json`;
      const serializedDocument = serializeCaptureDocument(document, metadata, status);

      await fs.writeFile(path.join(captureDirectory, filename), serializedDocument, {
        encoding: 'utf-8',
        flag: 'wx',
        mode: 0o600,
      });
      await this.prune(captureDirectory);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to write upstream 4xx capture: ${message}`);
    }
  }

  private async prune(captureDirectory: string): Promise<void> {
    const entries = await fs.readdir(captureDirectory, { withFileTypes: true });
    const captures = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map(async (entry) => {
          const filePath = path.join(captureDirectory, entry.name);
          const stats = await fs.stat(filePath);
          return { filePath, modifiedAt: stats.mtimeMs, size: stats.size };
        }),
    );
    const maxDirectoryBytes = readPositiveIntegerEnv(
      CAPTURE_DIRECTORY_MAX_BYTES_ENV,
      CAPTURE_DIRECTORY_MAX_BYTES,
    );
    const orderedCaptures = captures.sort(compareCaptureFiles);
    let retainedCount = orderedCaptures.length;
    let retainedBytes = orderedCaptures.reduce((total, capture) => total + capture.size, 0);

    for (const capture of orderedCaptures) {
      if (retainedCount <= CAPTURE_LIMIT && retainedBytes <= maxDirectoryBytes) {
        break;
      }

      await fs.unlink(capture.filePath);
      retainedCount -= 1;
      retainedBytes -= capture.size;
    }
  }
}

function compareCaptureFiles(left: CaptureFile, right: CaptureFile): number {
  if (left.modifiedAt !== right.modifiedAt) {
    return left.modifiedAt - right.modifiedAt;
  }

  return left.filePath.localeCompare(right.filePath);
}

function snapshotCaptureContext(
  context: UpstreamCaptureContext | undefined,
): UpstreamCaptureContext | undefined {
  if (!context) {
    return undefined;
  }

  const headers = snapshotCapturePayload(context.clientRequest.headers);
  return {
    clientRequest: {
      body: snapshotCapturePayload(context.clientRequest.body),
      endpoint:
        redactSensitiveQueryParams(snapshotCaptureText(context.clientRequest.endpoint)) ?? '',
      headers: isPlainObject(headers) ? (headers as Record<string, unknown>) : {},
    },
  };
}

function snapshotCaptureText(value: string): string {
  const snapshot = snapshotCapturePayload(value);
  return isString(snapshot) ? snapshot : '';
}

function serializeCaptureDocument(
  document: unknown,
  metadata: CaptureMetadata,
  status: number,
): string {
  const serializedDocument = JSON.stringify(document, null, 2);
  const originalSizeBytes = Buffer.byteLength(serializedDocument, 'utf-8');
  if (originalSizeBytes <= CAPTURE_MAX_BYTES) {
    return serializedDocument;
  }

  return JSON.stringify(
    {
      metadata: {
        ...mapMetadataStrings(metadata, (value) =>
          value.slice(0, CAPTURE_SUMMARY_FIELD_MAX_LENGTH),
        ),
        capture_truncated: true,
        max_size_bytes: CAPTURE_MAX_BYTES,
        original_size_bytes: originalSizeBytes,
      },
      upstream_response: { status },
      warning: 'Oversized request and response payloads were omitted from this capture.',
    },
    null,
    2,
  );
}

function mapMetadataStrings(
  metadata: CaptureMetadata,
  transform: (value: string) => string,
): CaptureMetadata {
  return {
    captured_at: transform(metadata.captured_at),
    client_visible_model: metadata.client_visible_model
      ? transform(metadata.client_visible_model)
      : null,
    mapped_upstream_model: metadata.mapped_upstream_model
      ? transform(metadata.mapped_upstream_model)
      : null,
    upstream_endpoint: transform(metadata.upstream_endpoint),
  };
}

function isClientErrorStatus(status: number | undefined): status is number {
  return status !== undefined && status >= 400 && status < 500;
}

function redactSensitiveQueryParams(endpoint: string | undefined): string | undefined {
  if (!endpoint) {
    return endpoint;
  }
  return endpoint.replace(SENSITIVE_QUERY_PARAM_PATTERN, '$1[REDACTED]');
}

function findModel(value: unknown): string | null {
  if (!isObjectLike(value)) {
    return null;
  }

  const record = value as { model?: unknown; request?: unknown };
  if (isString(record.model)) {
    return record.model;
  }
  if (isObjectLike(record.request)) {
    const model = (record.request as { model?: unknown }).model;
    return isString(model) ? model : null;
  }
  return null;
}

function findClientModel(body: unknown, endpoint: string | undefined): string | null {
  const bodyModel = findModel(body);
  if (bodyModel) {
    return bodyModel;
  }

  const match = endpoint?.match(/\/models\/([^/:?]+)/u);
  if (!match) {
    return null;
  }

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}
