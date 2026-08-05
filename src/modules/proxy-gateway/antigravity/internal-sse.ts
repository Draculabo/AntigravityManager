import { isObjectLike } from 'lodash-es';

/**
 * A single normalised Gemini response object decoded from one `v1internal`
 * SSE `data:` payload. Deliberately loosely typed (matching the rest of the
 * hand-rolled SSE parsing in this module) since callers only ever read a
 * handful of well-known fields off it.
 */
export type NormalizedInternalSseChunk = Record<string, any>;

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
 * Total: never throws. Malformed JSON, `[DONE]`, empty strings and non-object
 * payloads all resolve to `null` ("nothing here").
 */
export function parseInternalSseChunk(rawData: string): NormalizedInternalSseChunk | null {
  if (typeof rawData !== 'string') {
    return null;
  }

  const trimmed = rawData.trim();
  if (!trimmed || trimmed === '[DONE]') {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!isObjectLike(parsed) || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as NormalizedInternalSseChunk;
  const envelope = record.response;

  // Unwrap only when the envelope is actually present and the payload isn't
  // already unwrapped, so both `v1internal` (wrapped) and
  // `generativelanguage` (bare) shapes survive this same helper.
  if (isObjectLike(envelope) && !Array.isArray(envelope) && !('candidates' in record)) {
    return envelope as NormalizedInternalSseChunk;
  }

  return record;
}
