/**
 * Protocol text, rather than renderer copy. A terminal reason does not identify
 * the failed tool: preceding function calls may be valid and must not be blamed.
 */
export const MALFORMED_FUNCTION_CALL_RECOVERY_TEXT =
  'A tool call could not be generated. The upstream did not identify the failed tool.';

export function isMalformedFunctionCallFinishReason(
  finishReason: string | null | undefined,
): boolean {
  return finishReason?.toUpperCase() === 'MALFORMED_FUNCTION_CALL';
}

/** Maps Gemini terminal states to the finite OpenAI finish-reason vocabulary. */
export function mapGeminiFinishReasonToOpenAI(
  finishReason: string | null | undefined,
): string | null {
  if (!finishReason) {
    return null;
  }

  switch (finishReason.toUpperCase()) {
    case 'STOP':
    case 'MALFORMED_FUNCTION_CALL':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
      return 'content_filter';
    default:
      return null;
  }
}

/** A provider terminal state this gateway cannot interpret is not an account failure. */
export class UnsupportedGeminiFinishReasonError extends Error {
  readonly status = 502;
  readonly finishReason: string;
  readonly finishReasonTruncated: boolean;

  constructor(finishReason: string) {
    super('Upstream returned an unsupported finish reason.');
    this.name = 'UnsupportedGeminiFinishReasonError';
    this.finishReason = finishReason.slice(0, 256);
    this.finishReasonTruncated = finishReason.length > 256;
  }
}

/** Finds unsupported string terminal reasons without rewriting their original spelling. */
export function findUnsupportedGeminiFinishReason(response: {
  candidates?: unknown;
}): string | undefined {
  if (!Array.isArray(response.candidates)) {
    return undefined;
  }
  const candidates: unknown[] = response.candidates;
  for (const candidate of candidates) {
    if (
      candidate !== null &&
      typeof candidate === 'object' &&
      'finishReason' in candidate &&
      typeof candidate.finishReason === 'string' &&
      candidate.finishReason.length > 0 &&
      mapGeminiFinishReasonToOpenAI(candidate.finishReason) === null
    ) {
      return candidate.finishReason;
    }
  }
  return undefined;
}
