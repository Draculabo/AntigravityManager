import { isObjectLike } from 'lodash-es';

import type { GeminiContent } from '../../../../modules/proxy-gateway/antigravity/types';
import type { GeminiRequest } from '../../common/interfaces/request-interfaces';

/** A `countTokens` body the native contract cannot read, answered as `INVALID_ARGUMENT`. */
export class InvalidCountTokensRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCountTokensRequestError';
  }
}

export interface ResolvedCountTokensRequest {
  contents: GeminiContent[];
  request: GeminiRequest;
}

/**
 * Reads a native `countTokens` body.
 *
 * The public Gemini contract allows either a bare request or a `generateContentRequest`
 * wrapper. The full inner request must survive resolution because system instructions, tool
 * declarations and tool configuration all contribute to the local fallback estimate even though
 * only `contents` can be sent to the upstream count endpoint.
 */
export function resolveCountTokensRequest(body: unknown): ResolvedCountTokensRequest | null {
  if (!isObjectLike(body)) {
    return null;
  }

  const directRequest = body as GeminiRequest;
  const direct = directRequest.contents;
  if (Array.isArray(direct)) {
    return {
      contents: direct as GeminiContent[],
      request: directRequest,
    };
  }

  const wrapped = (body as { generateContentRequest?: unknown }).generateContentRequest;
  if (isObjectLike(wrapped) && Array.isArray((wrapped as GeminiRequest).contents)) {
    const wrappedRequest = wrapped as GeminiRequest;
    return {
      contents: wrappedRequest.contents as GeminiContent[],
      request: wrappedRequest,
    };
  }

  return null;
}
