import { Logger } from '@nestjs/common';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isObjectLike, isString } from 'lodash-es';
import { getAgentDir } from '@/shared/platform/paths';
import { sanitizeObject } from '@/shared/security/sensitiveDataMasking';
import { getUpstreamCaptureContext } from './upstream-capture-context';

const CAPTURE_DIRECTORY = 'captures';
const CAPTURE_LIMIT = 50;
const SENSITIVE_QUERY_PARAM_PATTERN =
  /([?&](?:api[_-]?key|key|access[_-]?token|refresh[_-]?token|token|authorization|auth|secret|client[_-]?secret|code)=)[^&#]*/giu;

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
export class Upstream4xxCaptureService {
  private readonly logger = new Logger(Upstream4xxCaptureService.name);

  async capture(input: Upstream4xxCaptureInput): Promise<void> {
    if (!isUpstream4xxCaptureEnabled() || !isClientErrorStatus(input.status)) {
      return;
    }

    try {
      const captureDirectory = path.join(getAgentDir(), CAPTURE_DIRECTORY);
      await fs.mkdir(captureDirectory, { recursive: true });
      const context = getUpstreamCaptureContext();
      const capturedAt = new Date().toISOString();
      const document = sanitizeObject({
        client_request: {
          body: context?.clientRequest.body,
          endpoint: redactSensitiveQueryParams(context?.clientRequest.endpoint),
          headers: context?.clientRequest.headers ?? {},
        },
        metadata: {
          captured_at: capturedAt,
          client_visible_model: findClientModel(
            context?.clientRequest.body,
            context?.clientRequest.endpoint,
          ),
          mapped_upstream_model: findModel(input.upstreamRequest),
          upstream_endpoint: redactSensitiveQueryParams(input.endpoint),
        },
        upstream_request: input.upstreamRequest,
        upstream_response: {
          error_body: input.upstreamErrorBody,
          status: input.status,
        },
      });
      const filename = `${capturedAt.replace(/[:.]/gu, '-')}-${randomUUID()}.json`;

      await fs.writeFile(
        path.join(captureDirectory, filename),
        JSON.stringify(document, null, 2),
        'utf-8',
      );
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
          return { filePath, modifiedAt: (await fs.stat(filePath)).mtimeMs };
        }),
    );
    const expired = captures
      .sort((left, right) => left.modifiedAt - right.modifiedAt)
      .slice(0, Math.max(0, captures.length - CAPTURE_LIMIT));

    await Promise.all(expired.map(({ filePath }) => fs.unlink(filePath)));
  }
}

export function isUpstream4xxCaptureEnabled(): boolean {
  return process.env.AGM_UPSTREAM_4XX_CAPTURE === '1';
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
  return decodeURIComponent(match[1]);
}
