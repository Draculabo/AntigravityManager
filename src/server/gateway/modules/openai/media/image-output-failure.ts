import type { GeminiResponse } from '../../../common/interfaces/request-interfaces';

const POLICY_FINISH_REASONS = new Set([
  'SAFETY',
  'IMAGE_SAFETY',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'IMAGE_PROHIBITED_CONTENT',
  'SPII',
]);

export type ImageOutputFailure =
  | 'image_policy_blocked'
  | 'image_text_only'
  | 'image_empty_response'
  | 'image_missing_data';

export const IMAGE_OUTPUT_FAILURE_MESSAGES: Record<ImageOutputFailure, string> = {
  image_policy_blocked: 'The upstream provider blocked image generation under its content policy.',
  image_text_only: 'The upstream provider returned text instead of an image.',
  image_empty_response: 'The upstream provider returned no image candidates.',
  image_missing_data: 'Upstream did not return inline image data.',
};

/** Describe a missing image without returning provider text or unrecognized reason values. */
export function classifyMissingImage(response: GeminiResponse): ImageOutputFailure {
  const candidate = response.candidates?.[0];
  if (
    POLICY_FINISH_REASONS.has(response.promptFeedback?.blockReason?.toUpperCase() ?? '') ||
    POLICY_FINISH_REASONS.has(candidate?.finishReason?.toUpperCase() ?? '')
  ) {
    return 'image_policy_blocked';
  }
  if (!candidate) {
    return 'image_empty_response';
  }
  const parts = candidate.content?.parts ?? [];
  if (
    parts.some(
      (part) => part.thought !== true && typeof part.text === 'string' && part.text.trim(),
    ) &&
    parts.every(
      (part) => !part.inlineData && !part.fileData && !part.functionCall && !part.functionResponse,
    )
  ) {
    return 'image_text_only';
  }
  return 'image_missing_data';
}
