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
 * Complete a supplied function-call signature alias without inventing a missing value.
 * Generation rejects conflicting aliases before account selection and history ingestion.
 */
export function normalizeFunctionCallSignatureAliases(contents: GeminiContent[]): GeminiContent[] {
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
      if (
        signature === undefined ||
        (part.thoughtSignature !== undefined && part.thought_signature !== undefined)
      ) {
        return part;
      }

      changed = true;
      contentChanged = true;
      return {
        ...part,
        thoughtSignature: part.thoughtSignature !== undefined ? part.thoughtSignature : signature,
        thought_signature:
          part.thought_signature !== undefined ? part.thought_signature : signature,
      };
    });

    return contentChanged ? { ...content, parts } : content;
  });

  return changed ? normalized : contents;
}
