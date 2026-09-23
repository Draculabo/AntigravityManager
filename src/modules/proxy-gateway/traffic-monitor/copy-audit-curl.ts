import { clipboard } from 'electron';
import { z } from 'zod';

import { ConfigManager } from '@/modules/config/ipc/manager';
import { getNestServerStatus } from '@/server/main';
import { getServerConfig } from '@/server/server-config';
import { isSensitiveAuditKey } from '../audit/audit-sanitizer';
import { trafficAuditService } from '../audit/traffic-audit.service';
import { formatCurlRequest } from '../curl-export/format-curl';

const MAX_COPY_BODY_BYTES = 8 * 1024 * 1024;
const HeaderRecordSchema = z.record(z.string(), z.unknown());

export interface CopyAuditCurlInput {
  id: string;
  attemptId?: string;
  includeCredentials: boolean;
}

export async function copyAuditCurl(input: CopyAuditCurlInput): Promise<void> {
  if (input.attemptId && input.includeCredentials) {
    throw new Error('Upstream attempts can only be copied with redacted credentials');
  }
  const detail = await trafficAuditService.detail(input.id);
  if (!detail || detail.recordKind !== 'request' || detail.request.trafficClass === 'ipc') {
    throw new Error('This request cannot be exported as cURL');
  }
  const attempt = input.attemptId
    ? detail.attempts.find((candidate) => candidate.id === input.attemptId)
    : null;
  if (input.attemptId && !attempt) {
    throw new Error('The upstream attempt no longer exists');
  }
  const ownerId = attempt?.id ?? detail.request.id;
  const body = detail.bodies.find(
    (candidate) => candidate.ownerId === ownerId && candidate.direction === 'request',
  );
  if (
    body &&
    (body.state !== 'complete' || body.partial || body.oversized || body.kind === 'binary')
  ) {
    throw new Error('The complete replayable request body is unavailable');
  }
  if (body && body.storedBytes > MAX_COPY_BODY_BYTES) {
    throw new Error('The request body exceeds the 8 MiB clipboard export limit');
  }
  let bodyText: string | undefined;
  if (body && body.kind !== 'empty') {
    let text = '';
    let cursor = 0;
    while (true) {
      const page = await trafficAuditService.bodyPage({
        bodyId: body.id,
        cursor,
        limitBytes: 256 * 1024,
      });
      if (!page || page.body.state !== 'complete') {
        throw new Error('The request body expired during export');
      }
      text += page.chunks.map((chunk) => chunk.data).join('');
      if (Buffer.byteLength(text, 'utf8') > MAX_COPY_BODY_BYTES) {
        throw new Error('The request body exceeds the 8 MiB clipboard export limit');
      }
      if (page.complete) {
        break;
      }
      if (page.nextCursor === null || page.nextCursor <= cursor) {
        throw new Error('The request body is incomplete');
      }
      cursor = page.nextCursor;
    }
    if (Buffer.byteLength(text, 'utf8') !== body.storedBytes) {
      throw new Error('The request body changed during export');
    }
    bodyText = text;
  }

  const parsedHeaders = HeaderRecordSchema.parse(
    JSON.parse(attempt?.requestHeaders ?? detail.request.requestHeaders),
  );
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsedHeaders)) {
    if (typeof value === 'string') {
      headers[name] = value;
    } else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      headers[name] = value.join(', ');
    }
  }
  if (input.includeCredentials) {
    const key = getServerConfig()?.api_key || ConfigManager.loadConfig().proxy.api_key;
    if (!key) {
      throw new Error('No current proxy API key is available');
    }
    for (const name of Object.keys(headers)) {
      if (isSensitiveAuditKey(name)) {
        delete headers[name];
      }
    }
    headers.Authorization = `Bearer ${key}`;
  }
  const status = await getNestServerStatus();
  const localBase = status.running
    ? status.base_url
    : `http://localhost:${ConfigManager.loadConfig().proxy.port}`;
  const rawUrl = attempt?.endpoint ?? detail.request.url;
  if (attempt && !/^https?:\/\//iu.test(rawUrl)) {
    throw new Error('The recorded upstream endpoint is not a replayable URL');
  }
  const url = new URL(rawUrl, localBase).toString();
  const parsedUrl = new URL(url);
  if (parsedUrl.username || parsedUrl.password) {
    parsedUrl.username = '';
    parsedUrl.password = '';
  }
  clipboard.writeText(
    formatCurlRequest(
      {
        method:
          attempt && /^(GET|POST|PUT|PATCH|DELETE)$/iu.test(attempt.operation)
            ? attempt.operation
            : detail.request.method,
        url: parsedUrl.toString(),
        headers,
        body: bodyText,
      },
      process.platform === 'win32' ? 'powershell' : 'posix',
    ),
  );
}
