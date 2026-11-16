import { isObjectLike } from 'lodash-es';
import type { GeminiResponse } from './types';
import {
  findUnsupportedGeminiFinishReason,
  UnsupportedGeminiFinishReasonError,
} from './GeminiFinishReason';

import { UpstreamGenerationError } from './UpstreamGenerationError';
import { isGeminiGenerationShape } from './gemini-response-shape';

export interface InternalSseError {
  cause?: UnsupportedGeminiFinishReasonError | UpstreamGenerationError;
  code?: number;
  status?: string;
  message: string;
  details?: unknown;
  source?: 'bare' | 'wrapped';
  messageTruncated?: boolean;
}

export type InternalSseDecodeResult =
  | { kind: 'response'; response: GeminiResponse; wrapped?: true }
  | { kind: 'error'; error: InternalSseError }
  | { kind: 'ignored' }
  | { kind: 'invalid' };

type ParsedInternalSsePayload = GeminiResponse & {
  response?: unknown;
  error?: unknown;
};

// A complete ASCII payload can occupy twice its wire size as a retained string.
// Keep large media events within the existing 128 MiB decoded-input budget.
export const MAX_SSE_EVENT_BYTES = 64 * 1024 * 1024;

/**
 * Extracts the payload of one SSE `data:` line.
 *
 * The SSE specification allows the field value to follow the colon with an
 * optional single space, so both `data:{...}` and `data: {...}` carry the same
 * event. Comment lines (`:` prefix) and other fields return `null` and stay
 * with the caller's own framing rules.
 */
export function parseSseDataLine(line: string): string | null {
  if (!line.startsWith('data:')) {
    return null;
  }
  const value = line.slice('data:'.length);
  return value.startsWith(' ') ? value.slice(1) : value;
}

/**
 * Collects `data:` fields until an SSE event boundary and joins them according
 * to the event-stream format. The retained payload is bounded so a malformed
 * upstream cannot grow the buffer without limit.
 */
export class IncrementalSseDataParser {
  private readonly dataLines: string[] = [];
  private dataBytes = 0;

  constructor(private readonly maxEventBytes = MAX_SSE_EVENT_BYTES) {}

  get estimatedRetainedBytes(): number {
    return this.dataBytes * 2 + this.dataLines.length * 64;
  }

  pushLine(rawLine: string): string | null {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      return this.dispatch();
    }

    const data = parseSseDataLine(line);
    if (data === null) {
      return null;
    }

    if (this.dataLines.length > 0) {
      const pending = this.dataLines.join('\n');
      try {
        JSON.parse(pending);
        this.reset();
        this.dataBytes = Buffer.byteLength(data, 'utf8');
        this.dataLines.push(data);
        return pending;
      } catch {
        // A provider occasionally omits the blank separator between ordinary
        // single-line records. Treat plainly non-JSON data as its own record;
        // retain JSON-looking prefixes for legitimate multiline payloads.
        const firstCharacter = pending.trimStart().at(0);
        if (firstCharacter !== '{' && firstCharacter !== '[') {
          this.reset();
          this.dataBytes = Buffer.byteLength(data, 'utf8');
          this.dataLines.push(data);
          return pending;
        }
      }
    }

    this.dataBytes += Buffer.byteLength(data, 'utf8') + (this.dataLines.length > 0 ? 1 : 0);
    if (this.dataBytes > this.maxEventBytes) {
      this.reset();
      throw new RangeError(`SSE event exceeded the ${this.maxEventBytes}-byte limit`);
    }
    this.dataLines.push(data);
    return null;
  }

  /** Accepts a complete EOF-terminated data event used by upstream providers. */
  finish(): string | null {
    return this.dispatch();
  }

  clear(): void {
    this.reset();
  }

  private dispatch(): string | null {
    if (this.dataLines.length === 0) {
      return null;
    }
    const payload = this.dataLines.join('\n');
    this.reset();
    return payload;
  }

  private reset(): void {
    this.dataLines.length = 0;
    this.dataBytes = 0;
  }
}

/**
 * Parses one raw SSE `data:` payload (the JSON text after the `data: `
 * prefix) coming from the `cloudcode-pa.googleapis.com/v1internal` upstream
 * and normalises it to a bare Gemini response object.
 *
 * The `v1internal` streaming endpoint wraps each chunk in a `{ response: ... }`
 * envelope while `generativelanguage`-shaped payloads (and the non-streaming
 * path, already unwrapped in GeminiClient.generateInternal) are bare. Both
 * shapes must come out the other end looking the same, so every parser can
 * read `candidates` / `usageMetadata` / `modelVersion` / `responseId` off the
 * top level unconditionally.
 *
 * Root/envelope containers and supported terminal reasons are validated here.
 * Protocol adapters narrow the remaining nested response fields before use.
 *
 * Total: never throws. Protocol-specific recovery remains with each caller.
 */
export function decodeInternalSseData(rawData: string): InternalSseDecodeResult {
  if (typeof rawData !== 'string') {
    return { kind: 'invalid' };
  }

  const trimmed = rawData.trim();
  if (!trimmed || trimmed === '[DONE]') {
    return { kind: 'ignored' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: 'invalid' };
  }

  return decodeInternalGeminiPayload(parsed);
}

/** Unary and SSE boundaries share error precedence and structural validation. */
export function decodeInternalGeminiPayload(parsed: unknown): InternalSseDecodeResult {
  if (!isObjectLike(parsed) || Array.isArray(parsed)) {
    return { kind: 'invalid' };
  }

  const payload = parsed as ParsedInternalSsePayload;
  const nested =
    payload.response !== null &&
    typeof payload.response === 'object' &&
    !Array.isArray(payload.response)
      ? (payload.response as { error?: unknown })
      : undefined;
  const source = 'error' in payload ? 'bare' : nested && 'error' in nested ? 'wrapped' : undefined;
  const errorContainer = source === 'bare' ? payload : source === 'wrapped' ? nested : undefined;
  if (
    errorContainer &&
    (!isObjectLike(errorContainer.error) || Array.isArray(errorContainer.error))
  ) {
    const cause = new UpstreamGenerationError('invalid_upstream_response');
    return { kind: 'error', error: { message: cause.message, cause, source } };
  }
  const errorValue =
    isObjectLike((payload as Record<string, unknown>).error) && !Array.isArray(payload.error)
      ? (payload as Record<string, unknown>).error
      : isObjectLike(payload.response) &&
          !Array.isArray(payload.response) &&
          isObjectLike((payload.response as Record<string, unknown>).error) &&
          !Array.isArray((payload.response as Record<string, unknown>).error)
        ? (payload.response as Record<string, unknown>).error
        : undefined;
  if (errorValue) {
    const errorRecord = errorValue as Record<string, unknown>;
    if (
      (errorRecord.message !== undefined && typeof errorRecord.message !== 'string') ||
      (errorRecord.status !== undefined && typeof errorRecord.status !== 'string') ||
      (errorRecord.details !== undefined && !Array.isArray(errorRecord.details)) ||
      (errorRecord.message === undefined &&
        errorRecord.code === undefined &&
        errorRecord.status === undefined) ||
      (errorRecord.code !== undefined &&
        (typeof errorRecord.code !== 'number' ||
          !Number.isInteger(errorRecord.code) ||
          errorRecord.code < 400 ||
          errorRecord.code > 599))
    ) {
      const cause = new UpstreamGenerationError('invalid_upstream_response');
      return { kind: 'error', error: { message: cause.message, cause, source } };
    }
    const originalMessage =
      typeof errorRecord.message === 'string' ? errorRecord.message : 'Upstream generation failed';
    let message = '';
    let bytes = 0;
    for (const character of originalMessage) {
      const size = Buffer.byteLength(character, 'utf8');
      if (bytes + size > 32768) {
        break;
      }
      message += character;
      bytes += size;
    }
    return {
      kind: 'error',
      error: {
        code: typeof errorRecord.code === 'number' ? errorRecord.code : undefined,
        status: typeof errorRecord.status === 'string' ? errorRecord.status : undefined,
        message,
        details: errorRecord.details,
        source,
        ...(message.length < originalMessage.length ? { messageTruncated: true } : {}),
      },
    };
  }

  const envelope = payload.response;

  // Unwrap only when the envelope is actually present and the payload isn't
  // already unwrapped, so both `v1internal` (wrapped) and
  // `generativelanguage` (bare) shapes survive this same helper.
  const wrapped = isObjectLike(envelope) && !Array.isArray(envelope) && !('candidates' in payload);
  const response = wrapped ? (envelope as GeminiResponse) : payload;
  if (!isGeminiGenerationShape(response)) {
    return { kind: 'invalid' };
  }
  const unsupportedReason = findUnsupportedGeminiFinishReason(response);
  if (unsupportedReason !== undefined) {
    const cause = new UnsupportedGeminiFinishReasonError(unsupportedReason);
    return {
      kind: 'error',
      error: { code: 502, status: 'UNSUPPORTED_FINISH_REASON', message: cause.message, cause },
    };
  }

  return {
    kind: 'response',
    response,
    ...(wrapped ? { wrapped: true } : {}),
  };
}

export function describeInternalSseError(error: unknown): string {
  if (isObjectLike(error) && !Array.isArray(error)) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim().length > 0) {
      return message;
    }
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' || typeof code === 'number') {
      return `Upstream returned error code ${String(code)}.`;
    }
  }
  return 'Upstream returned an error event.';
}
