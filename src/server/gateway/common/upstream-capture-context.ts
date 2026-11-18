import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Observable } from 'rxjs';

const CAPTURED_HEADER_NAMES = new Set([
  'anthropic-beta',
  'anthropic-version',
  'content-type',
  'user-agent',
  'x-goog-api-client',
]);
const MAX_CAPTURE_SNAPSHOT_BYTES = 256 * 1024;
const MAX_CAPTURE_SNAPSHOT_SOURCE_BYTES = 128 * 1024;
const MAX_CAPTURE_SNAPSHOT_DEPTH = 16;
const MAX_CAPTURE_SNAPSHOT_ENTRIES = 256;
const MAX_CAPTURE_SNAPSHOT_KEY_BYTES = 256;
const TRUNCATED_CAPTURE_VALUE = '[truncated]';
const SENSITIVE_CAPTURE_KEY_PATTERN =
  /(?:access|api|auth|bearer|client|id|refresh|session)[_-]?token|api[_-]?key|authorization|code|cookie|credential|otp|pass(?:word)?|pin|private[_-]?key|secret/iu;

export interface UpstreamCaptureContext {
  clientRequest: {
    body: unknown;
    endpoint: string;
    headers: Record<string, unknown>;
  };
}

const upstreamCaptureContext = new AsyncLocalStorage<UpstreamCaptureContext>();

export function getUpstreamCaptureContext(): UpstreamCaptureContext | undefined {
  return upstreamCaptureContext.getStore();
}

export function runWithUpstreamCaptureContext<T>(
  context: UpstreamCaptureContext,
  callback: () => T,
): T {
  return upstreamCaptureContext.run(context, callback);
}

export function isUpstream4xxCaptureEnabled(): boolean {
  return process.env.AGM_UPSTREAM_4XX_CAPTURE === '1';
}

/** Preserves the incoming wire request until the shared upstream transport (GeminiClient) resolves it. */
@Injectable()
export class UpstreamCaptureContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!isUpstream4xxCaptureEnabled()) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<{
      body?: unknown;
      headers?: Record<string, unknown>;
      url?: string;
    }>();

    const captureContext: UpstreamCaptureContext = {
      clientRequest: {
        body: snapshotCapturePayload(request.body),
        endpoint: request.url ?? '',
        headers: selectCaptureHeaders(request.headers),
      },
    };

    return new Observable((subscriber) =>
      upstreamCaptureContext.run(captureContext, () => next.handle().subscribe(subscriber)),
    );
  }
}

function selectCaptureHeaders(
  headers: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!headers) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => CAPTURED_HEADER_NAMES.has(name.toLowerCase())),
  );
}

export function snapshotCapturePayload(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }

  try {
    const snapshot = snapshotCaptureValue(value, {
      remainingBytes: MAX_CAPTURE_SNAPSHOT_SOURCE_BYTES,
      remainingEntries: MAX_CAPTURE_SNAPSHOT_ENTRIES,
      seen: new WeakSet(),
    });
    const serialized = JSON.stringify(snapshot);
    if (
      serialized === undefined ||
      Buffer.byteLength(serialized, 'utf-8') <= MAX_CAPTURE_SNAPSHOT_BYTES
    ) {
      return snapshot;
    }

    return {
      capture_truncated: true,
      max_snapshot_size_bytes: MAX_CAPTURE_SNAPSHOT_BYTES,
      original_snapshot_size_bytes: Buffer.byteLength(serialized, 'utf-8'),
      warning: 'Diagnostic payload snapshot exceeded the maximum size and was omitted.',
    };
  } catch {
    return '[request body unavailable for diagnostic capture]';
  }
}

interface CaptureSnapshotState {
  remainingBytes: number;
  remainingEntries: number;
  seen: WeakSet<object>;
}

function snapshotCaptureValue(value: unknown, state: CaptureSnapshotState, depth = 0): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return value;
  }

  if (typeof value === 'string') {
    return snapshotCaptureString(value, state);
  }

  if (Buffer.isBuffer(value)) {
    return snapshotCaptureString(`[binary request body omitted bytes=${value.byteLength}]`, state);
  }

  if (typeof value !== 'object') {
    return snapshotCaptureString(`[${typeof value} omitted]`, state);
  }

  if (state.seen.has(value)) {
    return '[Circular]';
  }
  if (
    depth >= MAX_CAPTURE_SNAPSHOT_DEPTH ||
    state.remainingBytes <= 0 ||
    state.remainingEntries <= 0
  ) {
    return TRUNCATED_CAPTURE_VALUE;
  }

  state.seen.add(value);
  if (Array.isArray(value)) {
    const snapshot: unknown[] = [];
    for (const item of value) {
      if (state.remainingEntries <= 0 || state.remainingBytes <= 0) {
        snapshot.push(TRUNCATED_CAPTURE_VALUE);
        break;
      }
      state.remainingEntries -= 1;
      snapshot.push(snapshotCaptureValue(item, state, depth + 1));
    }
    return snapshot;
  }

  const record = value as Record<string, unknown>;
  const snapshot: Record<string, unknown> = {};
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      continue;
    }
    if (state.remainingEntries <= 0 || state.remainingBytes <= 0) {
      snapshot.__truncated__ = true;
      break;
    }
    const snapshotKey = snapshotCaptureKey(key);
    state.remainingEntries -= 1;
    snapshot[snapshotKey] = isSensitiveCaptureKey(key)
      ? '[REDACTED]'
      : snapshotCaptureValue(record[key], state, depth + 1);
  }
  return snapshot;
}

function snapshotCaptureString(value: string, state: CaptureSnapshotState): string {
  const availableBytes = state.remainingBytes;
  if (availableBytes <= 0) {
    return TRUNCATED_CAPTURE_VALUE;
  }

  const suffix = ` ${TRUNCATED_CAPTURE_VALUE}`;
  const valueBytes = Buffer.byteLength(
    value.slice(0, Math.min(value.length, availableBytes)),
    'utf-8',
  );
  if (value.length <= availableBytes && valueBytes <= availableBytes) {
    state.remainingBytes -= valueBytes;
    return value;
  }

  const maxPrefixBytes = Math.max(0, availableBytes - Buffer.byteLength(suffix, 'utf-8'));
  const prefix = truncateUtf8String(value, maxPrefixBytes);
  state.remainingBytes = 0;
  return `${prefix}${suffix}`;
}

function snapshotCaptureKey(key: string): string {
  if (
    key.length <= MAX_CAPTURE_SNAPSHOT_KEY_BYTES &&
    Buffer.byteLength(key, 'utf-8') <= MAX_CAPTURE_SNAPSHOT_KEY_BYTES
  ) {
    return key;
  }

  return `${truncateUtf8String(key, MAX_CAPTURE_SNAPSHOT_KEY_BYTES - 1)}…`;
}

function isSensitiveCaptureKey(key: string): boolean {
  return SENSITIVE_CAPTURE_KEY_PATTERN.test(key) || key.toLowerCase() === 'key';
}

function truncateUtf8String(value: string, maxBytes: number): string {
  let lowerBound = 0;
  let upperBound = Math.min(value.length, maxBytes);
  while (lowerBound < upperBound) {
    const midpoint = Math.ceil((lowerBound + upperBound) / 2);
    if (Buffer.byteLength(value.slice(0, midpoint), 'utf-8') <= maxBytes) {
      lowerBound = midpoint;
    } else {
      upperBound = midpoint - 1;
    }
  }

  return value.slice(0, lowerBound);
}
