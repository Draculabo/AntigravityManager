import { isObjectLike } from 'lodash-es';
import type { GeminiResponse } from './types';

export type InternalSseDecodeResult =
  | {
      kind: 'response';
      response: GeminiResponse;
    }
  | {
      kind: 'ignored';
    }
  | {
      kind: 'invalid';
    };

type ParsedInternalSsePayload = GeminiResponse & {
  response?: unknown;
};

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
 * Only the root and envelope containers are validated here. Protocol adapters
 * keep responsibility for narrowing nested response fields before use.
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

  if (!isObjectLike(parsed) || Array.isArray(parsed)) {
    return { kind: 'invalid' };
  }

  const payload = parsed as ParsedInternalSsePayload;
  const envelope = payload.response;

  // Unwrap only when the envelope is actually present and the payload isn't
  // already unwrapped, so both `v1internal` (wrapped) and
  // `generativelanguage` (bare) shapes survive this same helper.
  if (isObjectLike(envelope) && !Array.isArray(envelope) && !('candidates' in payload)) {
    return {
      kind: 'response',
      response: envelope as GeminiResponse,
    };
  }

  return {
    kind: 'response',
    response: payload,
  };
}
