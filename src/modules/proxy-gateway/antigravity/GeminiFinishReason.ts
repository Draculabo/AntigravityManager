/**
 * A neutral recovery message for a malformed upstream function call. It is
 * deliberately not localized here because this is an OpenAI protocol payload,
 * not renderer copy, and it never claims that a command or tool succeeded.
 */
export const MALFORMED_FUNCTION_CALL_RECOVERY_TEXT =
  'The model could not complete a tool call. Please try again or adjust the requested tool.';

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
      return 'stop';
  }
}
