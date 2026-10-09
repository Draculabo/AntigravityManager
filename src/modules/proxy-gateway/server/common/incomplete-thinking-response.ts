import type { GeminiResponse } from './interfaces/request-interfaces';

/** Thought-only fragments without a terminal marker cannot complete a unary answer. */
export function isIncompleteThinkingResponse(response: GeminiResponse): boolean {
  const candidate = response.candidates?.[0];
  const parts = candidate?.content?.parts;
  return (
    !response.promptFeedback?.blockReason &&
    !candidate?.finishReason &&
    Array.isArray(parts) &&
    parts.length > 0 &&
    parts.every((part) => part.thought === true && !part.functionCall && !part.inlineData)
  );
}
