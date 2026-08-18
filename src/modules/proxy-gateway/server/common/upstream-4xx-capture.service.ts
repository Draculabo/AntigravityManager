import { Injectable, Logger } from '@nestjs/common';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isObjectLike, isString } from 'lodash-es';
import { getAgentDir } from '@/shared/platform/paths';
import { sanitizeObject } from '@/shared/security/sensitiveDataMasking';
import { getUpstreamCaptureContext, isUpstream4xxCaptureEnabled } from './upstream-capture-context';

const CAPTURE_DIRECTORY = 'captures';
const CAPTURE_LIMIT = 50;

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
  private readonly logger = new Logger(Upstream4xxCaptureService.name);

  async capture(input: Upstream4xxCaptureInput): Promise<void> {
    if (!isUpstream4xxCaptureEnabled() || !isClientErrorStatus(input.status)) {
      return;
    }

    try {
      const captureDirectory = path.join(getAgentDir(), CAPTURE_DIRECTORY);
      await fs.mkdir(captureDirectory, { mode: 0o700, recursive: true });
      if (process.platform !== 'win32') {
        await fs.chmod(captureDirectory, 0o700);
      }
      const context = getUpstreamCaptureContext();
      const capturedAt = new Date().toISOString();
      const document = sanitizeObject({
        client_request: {
          body: context?.clientRequest.body,
          endpoint: context?.clientRequest.endpoint,
          headers: context?.clientRequest.headers ?? {},
        },
        metadata: {
          captured_at: capturedAt,
          client_visible_model: findClientModel(
            context?.clientRequest.body,
            context?.clientRequest.endpoint,
          ),
          mapped_upstream_model: findModel(input.upstreamRequest),
          upstream_endpoint: input.endpoint,
        },
        upstream_request: input.upstreamRequest,
        upstream_response: {
          error_body: input.upstreamErrorBody,
          status: input.status,
        },
      });
      const filename = `${capturedAt.replace(/[:.]/gu, '-')}-${randomUUID()}.json`;

      await fs.writeFile(path.join(captureDirectory, filename), JSON.stringify(document, null, 2), {
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
          return { filePath, modifiedAt: (await fs.stat(filePath)).mtimeMs };
        }),
    );
    const expired = captures
      .sort((left, right) => left.modifiedAt - right.modifiedAt)
      .slice(0, Math.max(0, captures.length - CAPTURE_LIMIT));

    await Promise.all(expired.map(({ filePath }) => fs.unlink(filePath)));
  }
}

function isClientErrorStatus(status: number | undefined): status is number {
  return status !== undefined && status >= 400 && status < 500;
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
