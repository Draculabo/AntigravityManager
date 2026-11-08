import type { GeminiInternalRequest } from './types';

import { isThoughtSignaturePlaceholder } from './ThoughtSignatureCompat';

const MAX_CLASSIFIED_SIGNATURE_LENGTH = 1024 * 1024;
const STANDARD_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;

export type ThoughtSignatureFormat = 'claude-raw' | 'google-claude-wrapped' | 'opaque';
export type ThoughtSignatureFamily = 'claude' | 'gemini' | 'placeholder' | 'unknown';

interface ThoughtSignatureInspection {
  format: ThoughtSignatureFormat;
  family: ThoughtSignatureFamily;
}

function decodeStandardBase64(value: string): Buffer | null {
  if (
    value.length === 0 ||
    value.length > MAX_CLASSIFIED_SIGNATURE_LENGTH ||
    value.length % 4 !== 0 ||
    !STANDARD_BASE64.test(value)
  ) {
    return null;
  }

  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : null;
}

function readAscii(bytes: Buffer): string | null {
  if (bytes.some((byte) => byte > 0x7f)) {
    return null;
  }
  return bytes.toString('ascii');
}

function isRawClaudePayload(bytes: Buffer): boolean {
  if (bytes.length >= 3 && bytes[0] === 0x08 && bytes[1] === 0x04 && bytes[2] === 0x12) {
    return true;
  }

  const payload = bytes.toString('latin1').toLowerCase();
  return payload.includes('claude');
}

function inspectThoughtSignature(signature: string): ThoughtSignatureInspection {
  if (isThoughtSignaturePlaceholder(signature)) {
    return { format: 'opaque', family: 'placeholder' };
  }

  const decoded = decodeStandardBase64(signature);
  if (!decoded) {
    return { format: 'opaque', family: 'unknown' };
  }

  const innerSignature = readAscii(decoded);
  const innerPayload = innerSignature ? decodeStandardBase64(innerSignature) : null;
  if (innerPayload && isRawClaudePayload(innerPayload)) {
    return { format: 'google-claude-wrapped', family: 'claude' };
  }
  if (isRawClaudePayload(decoded)) {
    return { format: 'claude-raw', family: 'claude' };
  }
  // The encoded structure suggests the Gemini family without verifying signature validity.
  if (
    (signature.startsWith('E') || signature.startsWith('R')) &&
    signature.length >= 50 &&
    (decoded[0] === 0x12 || innerPayload?.[0] === 0x12)
  ) {
    return { format: 'opaque', family: 'gemini' };
  }
  return { format: 'opaque', family: 'unknown' };
}

/** Recognize conversion formats without treating Gemini binary payloads as client text. */
export function classifyThoughtSignature(signature: string): ThoughtSignatureFormat {
  return inspectThoughtSignature(signature).format;
}

/** Classify structural provenance separately from conversion or cryptographic validity. */
export function classifyThoughtSignatureFamily(signature: string): ThoughtSignatureFamily {
  return inspectThoughtSignature(signature).family;
}

/** Wrap only recognized raw Claude signatures for Google's bytes-backed field. */
export function toGoogleClaudeThoughtSignature(signature: string): string {
  if (classifyThoughtSignature(signature) !== 'claude-raw') {
    return signature;
  }
  return Buffer.from(signature, 'utf8').toString('base64');
}

/** Unwrap only a recognized Google wrapper before returning a signature to Claude clients. */
export function toClaudeClientThoughtSignature(signature: string): string {
  if (classifyThoughtSignature(signature) !== 'google-claude-wrapped') {
    return signature;
  }

  const decoded = decodeStandardBase64(signature);
  return decoded ? (readAscii(decoded) ?? signature) : signature;
}

/** Use a separate comparison form; persisted and emitted values remain untouched. */
export function normalizeThoughtSignatureForComparison(signature: string): string {
  return toClaudeClientThoughtSignature(signature);
}

export function areThoughtSignaturesEquivalent(left: string, right: string): boolean {
  return (
    left === right ||
    normalizeThoughtSignatureForComparison(left) === normalizeThoughtSignatureForComparison(right)
  );
}

/**
 * Convert recognized Claude signatures in a Google-bound request without mutating
 * the caller's history. Both aliases are mapped independently after generation
 * request validation has rejected conflicting values.
 */
export function prepareGeminiRequestThoughtSignatures(
  body: GeminiInternalRequest,
  onWrapped?: (message: number, part: number) => void,
): GeminiInternalRequest {
  let contents: typeof body.request.contents | undefined;
  for (const [contentIndex, content] of body.request.contents.entries()) {
    let parts: typeof content.parts | undefined;
    for (const [partIndex, part] of content.parts.entries()) {
      const thoughtSignature = part.thoughtSignature
        ? toGoogleClaudeThoughtSignature(part.thoughtSignature)
        : part.thoughtSignature;
      const snakeSignature = part.thought_signature
        ? toGoogleClaudeThoughtSignature(part.thought_signature)
        : part.thought_signature;
      if (thoughtSignature === part.thoughtSignature && snakeSignature === part.thought_signature) {
        continue;
      }
      onWrapped?.(contentIndex, partIndex);

      parts ??= [...content.parts];
      parts[partIndex] = {
        ...part,
        ...(part.thoughtSignature !== undefined ? { thoughtSignature } : {}),
        ...(part.thought_signature !== undefined ? { thought_signature: snakeSignature } : {}),
      };
    }

    if (parts) {
      contents ??= [...body.request.contents];
      contents[contentIndex] = { ...content, parts };
    }
  }

  if (!contents) {
    return body;
  }
  return {
    ...body,
    request: {
      ...body.request,
      contents,
    },
  };
}
