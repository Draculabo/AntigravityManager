import { createHash } from 'node:crypto';

import { isSensitiveAuditKey, MAX_AUDIT_BODY_BYTES, sanitizeAuditString } from './audit-sanitizer';
import { auditJsonObject } from './audit-json-object';

export const AUDIT_BODY_CHUNK_BYTES = 64 * 1024;
const STRING_PIECE_CODE_UNITS = 16 * 1024;
const MAX_SERIALIZATION_DEPTH = 256;
const REDACTED = '[REDACTED]';

export type IncrementalAuditPayloadKind = 'empty' | 'json' | 'text' | 'binary';

export interface IncrementalAuditSerializationResult {
  kind: IncrementalAuditPayloadKind;
  logicalBytes: number;
  oversized: boolean;
  sha256: string | null;
  storedBytes: number;
}

export type AuditChunkConsumer = (chunk: string, sequence: number) => boolean | Promise<boolean>;

/**
 * Serializes and sanitizes an audit value without constructing the complete output in memory.
 * The consumer receives UTF-8-safe chunks and may decline later chunks without stopping size/hash
 * accounting for the logical sanitized body.
 */
export async function serializeAuditPayloadIncrementally(
  value: unknown,
  consume: AuditChunkConsumer,
  maxStoredBytes = MAX_AUDIT_BODY_BYTES,
): Promise<IncrementalAuditSerializationResult> {
  if (value === undefined || value === null) {
    return {
      kind: 'empty',
      logicalBytes: 0,
      oversized: false,
      sha256: null,
      storedBytes: 0,
    };
  }

  const kind = payloadKind(value);
  const hash = createHash('sha256');
  const accumulator = new Utf8ChunkAccumulator(consume, maxStoredBytes);
  let logicalBytes = 0;
  let pieceCount = 0;

  for await (const piece of serializeValue(value, undefined, undefined, new WeakSet(), 0)) {
    const bytes = Buffer.from(piece, 'utf-8');
    hash.update(bytes);
    logicalBytes += bytes.byteLength;
    await accumulator.append(bytes);
    pieceCount += 1;
    if (pieceCount % 256 === 0) {
      await yieldToEventLoop();
    }
  }
  await accumulator.finish();

  return {
    kind,
    logicalBytes,
    oversized: logicalBytes > maxStoredBytes,
    sha256: hash.digest('hex'),
    storedBytes: accumulator.storedBytes,
  };
}

class Utf8ChunkAccumulator {
  private readonly parts: Buffer[] = [];
  private bufferedBytes = 0;
  private sequence = 0;
  private accepting = true;
  public storedBytes = 0;

  public constructor(
    private readonly consume: AuditChunkConsumer,
    private readonly maxStoredBytes: number,
  ) {}

  public async append(bytes: Buffer): Promise<void> {
    if (!this.accepting || this.storedBytes >= this.maxStoredBytes) {
      return;
    }

    let offset = 0;
    while (offset < bytes.byteLength && this.accepting && this.storedBytes < this.maxStoredBytes) {
      const remainingChunk = AUDIT_BODY_CHUNK_BYTES - this.bufferedBytes;
      const remainingLimit = this.maxStoredBytes - this.storedBytes - this.bufferedBytes;
      if (remainingLimit <= 0) {
        return;
      }
      const candidate = Math.min(remainingChunk, remainingLimit, bytes.byteLength - offset);
      let take = candidate;
      const end = offset + candidate;
      if (end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) {
        while (take > 0 && (bytes[offset + take]! & 0xc0) === 0x80) {
          take -= 1;
        }
      }
      if (take === 0) {
        if (this.bufferedBytes === 0) {
          return;
        }
        await this.flush();
        continue;
      }
      this.parts.push(bytes.subarray(offset, offset + take));
      this.bufferedBytes += take;
      offset += take;
      if (this.bufferedBytes === AUDIT_BODY_CHUNK_BYTES) {
        await this.flush();
      }
    }
  }

  public async finish(): Promise<void> {
    if (this.bufferedBytes > 0 && this.accepting) {
      await this.flush();
    }
  }

  private async flush(): Promise<void> {
    const chunk = Buffer.concat(this.parts, this.bufferedBytes);
    this.parts.length = 0;
    this.bufferedBytes = 0;
    const accepted = await this.consume(chunk.toString('utf-8'), this.sequence);
    if (!accepted) {
      this.accepting = false;
      return;
    }
    this.sequence += 1;
    this.storedBytes += chunk.byteLength;
  }
}

async function* serializeValue(
  value: unknown,
  key: string | undefined,
  inheritedMime: string | undefined,
  seen: WeakSet<object>,
  depth: number,
): AsyncGenerator<string> {
  if (key && isSensitiveAuditKey(key)) {
    yield* serializeJsonString(REDACTED);
    return;
  }
  if (value === null) {
    yield 'null';
    return;
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    yield 'null';
    return;
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    yield Number.isFinite(value) || typeof value === 'boolean' ? String(value) : 'null';
    return;
  }
  if (typeof value === 'bigint') {
    yield* serializeJsonString(value.toString());
    return;
  }
  if (typeof value === 'string') {
    const sanitized = sanitizeAuditString(value, key, inheritedMime);
    if (typeof sanitized === 'string') {
      yield* serializeJsonString(sanitized);
      return;
    }
    yield* serializeValue(sanitized, undefined, undefined, seen, depth + 1);
    return;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const buffer = Buffer.isBuffer(value)
      ? value
      : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    yield* serializeValue(
      {
        bytes: buffer.byteLength,
        mime_type: inheritedMime ?? 'application/octet-stream',
        redacted: true,
        sha256: createHash('sha256').update(buffer).digest('hex'),
        source: key ?? 'binary',
      },
      undefined,
      undefined,
      seen,
      depth + 1,
    );
    return;
  }
  if (value instanceof Date) {
    yield* serializeJsonString(value.toJSON());
    return;
  }
  if (depth >= MAX_SERIALIZATION_DEPTH) {
    yield* serializeJsonString('[depth limit]');
    return;
  }
  if (seen.has(value)) {
    yield* serializeJsonString('[Circular]');
    return;
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      yield '[';
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) {
          yield ',';
        }
        yield* serializeValue(value[index], undefined, inheritedMime, seen, depth + 1);
      }
      yield ']';
      return;
    }

    const record = auditJsonObject(value) ?? {};
    const mime = resolveMimeType(record) ?? inheritedMime;
    const keys = Object.keys(record).filter((entryKey) => {
      const entry = record[entryKey];
      return entry !== undefined && typeof entry !== 'function' && typeof entry !== 'symbol';
    });
    yield '{';
    for (let index = 0; index < keys.length; index += 1) {
      const entryKey = keys[index]!;
      if (index > 0) {
        yield ',';
      }
      yield* serializeJsonString(entryKey);
      yield ':';
      yield* serializeValue(record[entryKey], entryKey, mime, seen, depth + 1);
    }
    yield '}';
  } finally {
    seen.delete(value);
  }
}

async function* serializeJsonString(value: string): AsyncGenerator<string> {
  yield '"';
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let escaped: string;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        escaped = value.slice(index, index + 2);
        index += 1;
      } else {
        escaped = `\\u${code.toString(16).padStart(4, '0')}`;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      escaped = `\\u${code.toString(16).padStart(4, '0')}`;
    } else {
      switch (code) {
        case 0x08:
          escaped = '\\b';
          break;
        case 0x09:
          escaped = '\\t';
          break;
        case 0x0a:
          escaped = '\\n';
          break;
        case 0x0c:
          escaped = '\\f';
          break;
        case 0x0d:
          escaped = '\\r';
          break;
        case 0x22:
          escaped = '\\"';
          break;
        case 0x5c:
          escaped = '\\\\';
          break;
        default:
          escaped = code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : value[index]!;
      }
    }
    output += escaped;
    if (output.length >= STRING_PIECE_CODE_UNITS) {
      yield output;
      output = '';
    }
  }
  if (output) {
    yield output;
  }
  yield '"';
}

function payloadKind(value: unknown): IncrementalAuditPayloadKind {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return 'binary';
  }
  return typeof value === 'string' ? 'text' : 'json';
}

function resolveMimeType(record: Record<string, unknown>): string | undefined {
  const value = record.mimeType ?? record.mime_type ?? record.contentType ?? record.content_type;
  return typeof value === 'string' ? value.trim().toLowerCase() : undefined;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
