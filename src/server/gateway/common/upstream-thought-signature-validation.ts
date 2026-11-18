import { BadGatewayException } from '@nestjs/common';

import { areThoughtSignaturesEquivalent } from '../../../modules/proxy-gateway/antigravity/thought-signature-format';

/** A successful HTTP response with ambiguous signatures cannot authorize another generation. */
export class UpstreamThoughtSignatureConflictError extends BadGatewayException {
  constructor(position: string) {
    super(`Conflicting upstream thoughtSignature and thought_signature at ${position}.`);
  }
}

function findPartConflict(payload: unknown): string | null {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('candidates' in payload) ||
    !Array.isArray(payload.candidates)
  ) {
    return null;
  }
  const candidates: readonly unknown[] = payload.candidates;
  for (const [candidateIndex, candidate] of candidates.entries()) {
    if (!candidate || typeof candidate !== 'object' || !('content' in candidate)) {
      continue;
    }
    const content: unknown = candidate.content;
    if (
      !content ||
      typeof content !== 'object' ||
      !('parts' in content) ||
      !Array.isArray(content.parts)
    ) {
      continue;
    }
    const parts: readonly unknown[] = content.parts;
    for (const [partIndex, part] of parts.entries()) {
      if (
        !part ||
        typeof part !== 'object' ||
        !('thoughtSignature' in part) ||
        !('thought_signature' in part)
      ) {
        continue;
      }
      const left: unknown = part.thoughtSignature;
      const right: unknown = part.thought_signature;
      if (
        left === undefined ||
        right === undefined ||
        (typeof left === 'string' &&
          typeof right === 'string' &&
          areThoughtSignaturesEquivalent(left, right))
      ) {
        continue;
      }
      return `candidates[${candidateIndex}].content.parts[${partIndex}]`;
    }
  }
  return null;
}

/** Inspect only the two supported envelope shapes, without copying or logging provider values. */
export function findUpstreamThoughtSignatureConflict(
  payload: unknown,
): UpstreamThoughtSignatureConflictError | null {
  const direct = findPartConflict(payload);
  if (direct) {
    return new UpstreamThoughtSignatureConflictError(direct);
  }
  if (payload && typeof payload === 'object' && 'response' in payload) {
    const wrapped = findPartConflict(payload.response);
    if (wrapped) {
      return new UpstreamThoughtSignatureConflictError(wrapped);
    }
  }
  return null;
}
