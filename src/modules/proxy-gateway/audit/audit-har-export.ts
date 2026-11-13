import { z } from 'zod';
import { name, version } from '../../../../package.json';
import { sanitizeAuditHeaders, sanitizeAuditUrl } from './audit-sanitizer';
import type { TrafficAuditBodyDescriptor, TrafficAuditDetail } from './traffic-audit.types';

interface HarExportSource {
  detail(id: string): Promise<TrafficAuditDetail | null>;
  body(id: string): AsyncGenerator<string>;
}
interface Header {
  name: string;
  value: string;
}
interface Exchange {
  id: string;
  kind: 'parent' | 'attempt';
  method: string;
  url: string;
  timestamp: number;
  durationMs: number | null;
  status: number | null;
  requestHeaders: string;
  responseHeaders: string | null;
  outcome: string;
}

function headers(raw: string | null): Header[] {
  if (raw === null) {
    return [];
  }
  const record = z.record(z.string(), z.unknown()).parse(JSON.parse(raw));
  return Object.entries(sanitizeAuditHeaders(record)).flatMap(([name, value]) => {
    const values = Array.isArray(value) ? value : [value];
    return values.map((item) => ({
      name,
      value: typeof item === 'string' ? item : (JSON.stringify(item) ?? ''),
    }));
  });
}

function location(captured: string) {
  let safe = sanitizeAuditUrl(captured);
  let absolute = false;
  try {
    const url = new URL(safe);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Unsupported audit URL');
    }
    url.username = '';
    url.password = '';
    url.hash = '';
    safe = url.href;
    absolute = true;
  } catch {
    // Legacy inbound records store a request target without scheme or authority.
  }
  const url = absolute ? safe : `http://unknown.invalid/${safe.replace(/^\/+/, '')}`;
  return { url, capturedUrl: safe, originKnown: absolute };
}

function captureMetadata(body: TrafficAuditBodyDescriptor | undefined) {
  return body
    ? {
        state: body.state,
        representation: body.representation,
        partial: body.partial,
        storedBytes: body.storedBytes,
        logicalBytes: body.logicalBytes,
        oversized: body.oversized,
        droppedReason: body.droppedReason,
      }
    : { state: 'not-captured' };
}

/** HAR describes saved sanitized representations, never byte-identical wire captures. */
export async function* auditHarForExport(
  requestId: string,
  source: HarExportSource,
): AsyncGenerator<string> {
  const detail = await source.detail(requestId);
  if (
    !detail ||
    detail.recordKind !== 'request' ||
    detail.request.trafficClass === 'ipc' ||
    detail.request.outcome === 'in_progress' ||
    detail.attempts.some((attempt) => attempt.outcome === 'in_progress') ||
    detail.bodies.some((body) => body.state === 'writing')
  ) {
    throw new Error('Audit request must be settled before HAR export');
  }
  const snapshot = JSON.stringify(detail);
  const exchanges: Exchange[] = [
    { ...detail.request, kind: 'parent' },
    ...detail.attempts.map((attempt) => ({
      ...attempt,
      kind: 'attempt' as const,
      url: attempt.endpoint,
      method: '',
    })),
  ];
  yield `{"log":{"version":"1.2","creator":${JSON.stringify({ name, version })},"comment":"Saved sanitized audit representations. Unknown origin uses unknown.invalid, which is not a measured destination. Unknown transport phases and HTTP methods are not inferred.","entries":[`;
  for (let index = 0; index < exchanges.length; index += 1) {
    const exchange = exchanges[index];
    if (index > 0) {
      yield ',';
    }
    const requestHeaders = headers(exchange.requestHeaders);
    const responseHeaders = headers(exchange.responseHeaders);
    const address = location(exchange.url);
    const requestBody = detail.bodies.find(
      (body) =>
        body.ownerId === exchange.id &&
        body.ownerKind === exchange.kind &&
        body.direction === 'request',
    );
    const responseBody = detail.bodies.find(
      (body) =>
        body.ownerId === exchange.id &&
        body.ownerKind === exchange.kind &&
        body.direction === 'response',
    );
    const attempt =
      exchange.kind === 'attempt'
        ? detail.attempts.find((item) => item.id === exchange.id)
        : undefined;
    const entry = {
      startedDateTime: new Date(exchange.timestamp).toISOString(),
      time: exchange.durationMs ?? 0,
      comment:
        'Time is the observed audit operation duration; unobserved transport phases are -1, so no complete phase sum is available. A zero time with _agm.durationMs null means unknown.',
      cache: {},
      timings: {
        blocked: -1,
        dns: -1,
        connect: -1,
        ssl: -1,
        send: -1,
        wait: -1,
        receive: -1,
        comment:
          'Transport phase breakdown is unavailable. See _agm.durationMs for the measured operation duration.',
      },
      _agm: {
        id: exchange.id,
        kind: exchange.kind,
        outcome: exchange.outcome,
        durationMs: exchange.durationMs,
        timing: attempt?.timing ?? null,
        capturedUrl: address.capturedUrl,
        originKnown: address.originKnown,
        methodKnown: exchange.method !== '',
        timingBreakdownKnown: false,
      },
    };
    yield `${JSON.stringify(entry).slice(0, -1)},"request":`;
    const request = {
      method: exchange.method,
      url: address.url,
      httpVersion: '',
      cookies: [],
      headers: requestHeaders,
      queryString: [...new URL(address.url).searchParams].map(([name, value]) => ({ name, value })),
      headersSize: -1,
      bodySize: -1,
    };
    yield `${JSON.stringify(request).slice(0, -1)},"postData":`;
    yield* bodyObject(requestBody, 'request');
    yield '},"response":';
    const response = {
      status: exchange.status ?? 0,
      statusText: '',
      httpVersion: '',
      cookies: [],
      headers: responseHeaders,
      redirectURL:
        responseHeaders.find((header) => header.name.toLowerCase() === 'location')?.value ?? '',
      headersSize: -1,
      bodySize: -1,
    };
    yield `${JSON.stringify(response).slice(0, -1)},"content":`;
    yield* bodyObject(responseBody, 'response');
    yield '}}';
  }
  if (JSON.stringify(await source.detail(requestId)) !== snapshot) {
    throw new Error('Audit request changed during HAR export');
  }
  yield ']}}';

  async function* bodyObject(
    body: TrafficAuditBodyDescriptor | undefined,
    direction: 'request' | 'response',
  ) {
    const available = body && body.state !== 'expired';
    const metadata = {
      mimeType:
        body?.representation === 'sanitized_json' || body?.representation === 'reconstructed_sse'
          ? 'application/json'
          : 'text/plain',
      ...(direction === 'response' ? { size: body?.storedBytes ?? 0 } : {}),
      _agm: captureMetadata(body),
    };
    if (!available) {
      yield JSON.stringify(metadata);
      return;
    }
    yield `${JSON.stringify(metadata).slice(0, -1)},"text":"`;
    for await (const chunk of source.body(body.id)) {
      yield JSON.stringify(chunk).slice(1, -1);
    }
    yield '"}';
  }
}
