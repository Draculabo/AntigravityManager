import { isObjectLike } from 'lodash-es';

import type { GeminiContent } from '../../../antigravity/types';
import type { GeminiRequest } from '../../common/interfaces/request-interfaces';

/** A `countTokens` body the native contract cannot read, answered as `INVALID_ARGUMENT`. */
export class InvalidCountTokensRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCountTokensRequestError';
  }
}

/**
 * Reads the conversation out of a native `countTokens` body.
 *
 * The public Gemini contract allows either bare `contents` or a `generateContentRequest`
 * wrapper. `null` means neither was present, which the controller reports as
 * `INVALID_ARGUMENT` rather than counting an empty conversation and answering 0.
 */
export function resolveCountTokensContents(body: unknown): GeminiContent[] | null {
  if (!isObjectLike(body)) {
    return null;
  }

  const direct = (body as GeminiRequest).contents;
  if (Array.isArray(direct)) {
    return direct as GeminiContent[];
  }

  const wrapped = (body as { generateContentRequest?: unknown }).generateContentRequest;
  if (isObjectLike(wrapped) && Array.isArray((wrapped as GeminiRequest).contents)) {
    return (wrapped as GeminiRequest).contents as GeminiContent[];
  }

  return null;
}
