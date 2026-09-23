import { createHash } from 'node:crypto';
import { isString } from 'lodash-es';
import { auditJsonObject } from './audit-json-object';

export const MAX_AUDIT_BODY_BYTES = 100 * 1024 * 1024;
export const MAX_AUDIT_STREAM_BYTES = MAX_AUDIT_BODY_BYTES;
const MAX_AUDIT_DEPTH = 32;
const MAX_AUDIT_ENTRIES = 20_000;
const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_PATTERN =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|x-goog-api-key|x-anthropic-api-key|access[-_]?token|refresh[-_]?token|id[-_]?token|bearer[-_]?token|client[-_]?secret|private[-_]?key|password|passwd|credential|credentials|oauth[-_]?token|session[-_]?token)$/iu;
const SENSITIVE_SUFFIX_PATTERN =
  /(?:^|[-_])(?:access|refresh|identity|id|session|auth|bearer)[-_]?token$/iu;
const DATA_URL_PATTERN = /^data:([^;,]+)((?:;[^,;]*)*),(.*)$/isu;
const BASE64_KEYS = new Set(['b64_json', 'base64', 'base64_data', 'base64data']);

export type AuditPayloadKind = 'empty' | 'json' | 'text' | 'binary' | 'oversized';

export interface AuditPayloadSnapshot {
  bytes: number;
  kind: AuditPayloadKind;
  oversized: boolean;
  sha256: string | null;
  text: string | null;
}

interface SanitizeState {
  entries: number;
  maxBytes: number;
  outputBytes: number;
  seen: WeakSet<object>;
  truncated: boolean;
}

export function isSensitiveAuditKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return SENSITIVE_KEY_PATTERN.test(normalized) || SENSITIVE_SUFFIX_PATTERN.test(normalized);
}

export function sanitizeAuditHeaders(
  headers: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!headers) {
    return {};
  }
  return auditJsonObject(sanitizeAuditValue(headers)) ?? {};
}

export function sanitizeAuditUrl(rawUrl: string): string {
  const [path, query = ''] = rawUrl.split('?', 2);
  if (!query) {
    return rawUrl;
  }

  const params = new URLSearchParams(query);
  for (const key of [...params.keys()]) {
    if (isSensitiveAuditKey(key)) {
      params.set(key, REDACTED);
    }
  }
  const rendered = params.toString();
  return rendered ? `${path}?${rendered}` : path;
}

export function snapshotAuditPayload(
  value: unknown,
  maxBytes = MAX_AUDIT_BODY_BYTES,
): AuditPayloadSnapshot {
  if (value === undefined || value === null) {
    return { bytes: 0, kind: 'empty', oversized: false, sha256: null, text: null };
  }

  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const bytes = Buffer.isBuffer(value)
      ? value
      : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return binarySnapshot(bytes, 'application/octet-stream', 'request-body');
  }

  if (isString(value)) {
    const bytes = Buffer.byteLength(value, 'utf-8');
    if (bytes > maxBytes) {
      return oversizedSnapshot(bytes, sha256Hex(value));
    }
  }

  const state = createSanitizeState(maxBytes);
  const sanitized = sanitizeValue(value, state, undefined, undefined, 0);
  const isText = isString(sanitized);
  let text: string;
  try {
    text = isText ? sanitized : JSON.stringify(sanitized);
  } catch {
    text = '[payload serialization failed]';
  }
  const bytes = Buffer.byteLength(text, 'utf-8');
  const sha256 = sha256Hex(text);
  if (state.truncated || bytes > maxBytes) {
    return oversizedSnapshot(Math.max(bytes, state.outputBytes), sha256);
  }

  return {
    bytes,
    kind: isText ? 'text' : 'json',
    oversized: false,
    sha256,
    text,
  };
}

export function sanitizeAuditValue(value: unknown): unknown {
  return sanitizeValue(value, createSanitizeState(MAX_AUDIT_BODY_BYTES), undefined, undefined, 0);
}

function createSanitizeState(maxBytes: number): SanitizeState {
  return {
    entries: 0,
    maxBytes,
    outputBytes: 0,
    seen: new WeakSet(),
    truncated: false,
  };
}

function sanitizeValue(
  value: unknown,
  state: SanitizeState,
  key: string | undefined,
  inheritedMime: string | undefined,
  depth: number,
): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    state.outputBytes += Buffer.byteLength(String(value), 'utf-8');
    return value;
  }
  if (isString(value)) {
    if (key && isSensitiveAuditKey(key)) {
      return REDACTED;
    }
    const sanitized = sanitizeAuditString(value, key, inheritedMime);
    if (isString(sanitized)) {
      const bytes = Buffer.byteLength(sanitized, 'utf-8');
      if (state.outputBytes + bytes > state.maxBytes) {
        state.truncated = true;
        return omittedValue(value);
      }
      state.outputBytes += bytes;
    } else {
      state.outputBytes += 256;
    }
    return sanitized;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return binarySummary(
      Buffer.from(value),
      inheritedMime ?? 'application/octet-stream',
      key ?? 'binary',
    );
  }
  if (typeof value !== 'object') {
    return String(value);
  }
  if (state.seen.has(value)) {
    return '[Circular]';
  }
  if (depth >= MAX_AUDIT_DEPTH || state.entries >= MAX_AUDIT_ENTRIES) {
    state.truncated = true;
    return '[truncated]';
  }

  state.seen.add(value);
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (const item of value) {
      if (state.outputBytes >= state.maxBytes || state.entries >= MAX_AUDIT_ENTRIES) {
        state.truncated = true;
        output.push('[truncated]');
        break;
      }
      state.entries += 1;
      output.push(sanitizeValue(item, state, undefined, inheritedMime, depth + 1));
    }
    return output;
  }

  const record = auditJsonObject(value) ?? {};
  const mime = resolveMimeType(record) ?? inheritedMime;
  const output: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(record)) {
    if (state.outputBytes >= state.maxBytes || state.entries >= MAX_AUDIT_ENTRIES) {
      state.truncated = true;
      output['[truncated]'] = true;
      break;
    }
    state.entries += 1;
    state.outputBytes += Buffer.byteLength(entryKey, 'utf-8');
    if (isSensitiveAuditKey(entryKey)) {
      output[entryKey] = REDACTED;
      continue;
    }
    output[entryKey] = sanitizeValue(entryValue, state, entryKey, mime, depth + 1);
  }
  return output;
}

export function sanitizeAuditString(value: string, key?: string, mimeType?: string): unknown {
  const dataUrl = DATA_URL_PATTERN.exec(value);
  if (dataUrl) {
    const [, mime, metadata, data] = dataUrl;
    if (metadata.toLowerCase().split(';').includes('base64')) {
      return base64Summary(data, mime, key ?? 'data-url');
    }
    const bytes = Buffer.byteLength(data, 'utf-8');
    return {
      bytes,
      mime_type: mime,
      redacted: true,
      sha256: sha256Hex(data),
      source: key ?? 'data-url',
    };
  }

  const normalizedKey = key?.toLowerCase();
  const inlineMedia = normalizedKey === 'data' && mimeType && !mimeType.startsWith('text/');
  if ((normalizedKey && BASE64_KEYS.has(normalizedKey)) || inlineMedia) {
    return base64Summary(value, mimeType ?? 'application/octet-stream', key ?? 'base64');
  }

  return redactUrlCredentials(value);
}

function base64Summary(value: string, mimeType: string, source: string): Record<string, unknown> {
  const hash = createHash('sha256');
  let carry = '';
  let bytes = 0;
  try {
    for (let offset = 0; offset < value.length; offset += 64 * 1024) {
      const normalized = carry + value.slice(offset, offset + 64 * 1024).replace(/\s+/gu, '');
      const consumableLength = normalized.length - (normalized.length % 4);
      const decoded = Buffer.from(normalized.slice(0, consumableLength), 'base64');
      hash.update(decoded);
      bytes += decoded.byteLength;
      carry = normalized.slice(consumableLength);
    }
    if (carry) {
      const decoded = Buffer.from(carry, 'base64');
      hash.update(decoded);
      bytes += decoded.byteLength;
    }
  } catch {
    hash.update(value, 'utf-8');
    bytes = Buffer.byteLength(value, 'utf-8');
  }
  return { bytes, mime_type: mimeType, redacted: true, sha256: hash.digest('hex'), source };
}

function binarySummary(bytes: Buffer, mimeType: string, source: string): Record<string, unknown> {
  return {
    bytes: bytes.byteLength,
    mime_type: mimeType,
    redacted: true,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    source,
  };
}

function binarySnapshot(bytes: Buffer, mimeType: string, source: string): AuditPayloadSnapshot {
  const summary = binarySummary(bytes, mimeType, source);
  return {
    bytes: bytes.byteLength,
    kind: 'binary',
    oversized: false,
    sha256: String(summary.sha256),
    text: JSON.stringify(summary),
  };
}

function omittedValue(value: string): Record<string, unknown> {
  return {
    bytes: Buffer.byteLength(value, 'utf-8'),
    omitted: true,
    reason: 'audit_body_limit',
    sha256: sha256Hex(value),
  };
}

function oversizedSnapshot(bytes: number, sha256: string): AuditPayloadSnapshot {
  return {
    bytes,
    kind: 'oversized',
    oversized: true,
    sha256,
    text: JSON.stringify({ bytes, omitted: true, reason: 'audit_body_limit', sha256 }),
  };
}

function resolveMimeType(record: Record<string, unknown>): string | undefined {
  const value = record.mimeType ?? record.mime_type ?? record.contentType ?? record.content_type;
  return isString(value) ? value.trim().toLowerCase() : undefined;
}

export function redactUrlCredentials(value: string): string {
  return value
    .replace(/\b((?:https?|socks5?):\/\/)[^/\s@]+@/giu, '$1[REDACTED]@')
    .replace(
      /([?&](?:access_token|refresh_token|id_token|api_key|key|client_secret)=)[^&#\s]*/giu,
      '$1[REDACTED]',
    );
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}
