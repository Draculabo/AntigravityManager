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

/** A normal STOP with only hidden reasoning must not become a visible placeholder answer. */
export function isFinishedThinkingOnlyResponse(response: GeminiResponse): boolean {
  const candidate = response.candidates?.[0];
  const parts = candidate?.content?.parts;
  return (
    !response.promptFeedback?.blockReason &&
    candidate?.finishReason?.toUpperCase() === 'STOP' &&
    Array.isArray(parts) &&
    parts.length > 0 &&
    parts.every((part) => part.thought === true && !part.functionCall && !part.inlineData)
  );
}
