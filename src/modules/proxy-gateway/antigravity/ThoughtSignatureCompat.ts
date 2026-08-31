import type { GeminiContent } from './types';

export const PLACEHOLDER_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

export function isGeminiFlashModel(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  return normalized.includes('gemini') && normalized.includes('flash');
}

export function modelKeepsThinkingWithoutSignature(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  return isGeminiFlashModel(normalized) || normalized.includes('gemini-pro-agent');
}

/**
 * Replays unsigned tool history using the provider sentinel accepted by Gemini Flash models.
 * Existing provider signatures are authoritative and are never rewritten.
 */
export function injectPlaceholderSignaturesForModel(
  contents: GeminiContent[],
  modelName: string,
): GeminiContent[] {
  let changed = false;
  const normalized = contents.map((content) => {
    let contentChanged = false;
    const parts = content.parts.map((part) => {
      if (!part.functionCall) {
        return part;
      }

      // Match JSON field presence, not truthiness or nullish coalescing: supplied aliases win.
      const signature =
        part.thoughtSignature !== undefined ? part.thoughtSignature : part.thought_signature;
      const fallback =
        signature !== undefined
          ? signature
          : isGeminiFlashModel(modelName)
            ? PLACEHOLDER_THOUGHT_SIGNATURE
            : undefined;
      if (
        fallback === undefined ||
        (part.thoughtSignature !== undefined && part.thought_signature !== undefined)
      ) {
        return part;
      }

      changed = true;
      contentChanged = true;
      return {
        ...part,
        thoughtSignature: part.thoughtSignature !== undefined ? part.thoughtSignature : fallback,
        thought_signature: part.thought_signature !== undefined ? part.thought_signature : fallback,
      };
    });

    return contentChanged ? { ...content, parts } : content;
  });

  return changed ? normalized : contents;
}
