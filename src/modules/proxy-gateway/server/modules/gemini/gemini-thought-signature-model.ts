import type { GeminiPart } from '../../../antigravity/types';
import { classifyThoughtSignatureFamily } from '../../../antigravity/thought-signature-format';
import { normalizeThoughtSignatureModelContext } from '../../../antigravity/thought-signature-model';
import {
  InvalidThoughtSignatureModelError,
  type ThoughtSignatureTargetFamily,
} from '../../common/invalid-thought-signature-model.exception';

type SignatureAliases = Pick<GeminiPart, 'thoughtSignature' | 'thought_signature'>;

function resolveTargetFamily(model: string): ThoughtSignatureTargetFamily {
  const context = normalizeThoughtSignatureModelContext({ model });
  const target = context?.family ?? context?.model ?? '';
  if (target.startsWith('claude-')) {
    return 'claude';
  }
  if (target.startsWith('gemini-')) {
    return 'gemini';
  }
  return 'unknown';
}

/**
 * Run after alias validation with the routed physical model, before history capture.
 * Unknown formats remain opaque; format recognition cannot override recorded model ownership.
 */
export function assertGeminiThoughtSignatureModel(
  contents: readonly { parts: readonly SignatureAliases[] }[],
  model: string,
): void {
  const target = resolveTargetFamily(model);
  for (const [contentIndex, content] of contents.entries()) {
    for (const [partIndex, part] of content.parts.entries()) {
      const signature = part.thoughtSignature ?? part.thought_signature;
      if (!signature) {
        continue;
      }
      const source = classifyThoughtSignatureFamily(signature);
      if (
        (source !== 'unknown' && target === 'unknown') ||
        (source === 'placeholder' && target !== 'gemini') ||
        (source === 'claude' && target === 'gemini') ||
        (source === 'gemini' && target === 'claude')
      ) {
        throw new InvalidThoughtSignatureModelError(
          `contents[${contentIndex}].parts[${partIndex}]`,
          target,
        );
      }
    }
  }
}
