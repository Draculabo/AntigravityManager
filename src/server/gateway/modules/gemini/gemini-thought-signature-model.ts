import type { GeminiContent, GeminiPart } from '../../../../modules/proxy-gateway/antigravity/types';
import { classifyThoughtSignatureFamily } from '../../../../modules/proxy-gateway/antigravity/thought-signature-format';
import { normalizeThoughtSignatureModelContext } from '../../../../modules/proxy-gateway/antigravity/thought-signature-model';
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

const MODEL_SWITCH_EVIDENCE_MS = 10 * 60 * 1000;
const MAX_MODEL_SWITCH_SESSIONS = 1024;

export class GeminiModelSwitchHistory {
  private readonly geminiSuccess = new Map<string, number>();

  recordSuccess(sessionKey: string | undefined, model: string, now = Date.now()): void {
    if (!sessionKey || resolveTargetFamily(model) !== 'gemini') {
      return;
    }
    this.geminiSuccess.delete(sessionKey);
    this.geminiSuccess.set(sessionKey, now + MODEL_SWITCH_EVIDENCE_MS);
    if (this.geminiSuccess.size > MAX_MODEL_SWITCH_SESSIONS) {
      const oldest = this.geminiSuccess.keys().next().value;
      if (oldest !== undefined) {
        this.geminiSuccess.delete(oldest);
      }
    }
  }

  prepare(
    contents: GeminiContent[],
    requestedModel: string,
    targetModel: string,
    sessionKey: string | undefined,
    now = Date.now(),
  ): GeminiContent[] {
    const expiresAt = sessionKey ? this.geminiSuccess.get(sessionKey) : undefined;
    if (
      expiresAt === undefined ||
      expiresAt <= now ||
      resolveTargetFamily(requestedModel) !== 'claude' ||
      resolveTargetFamily(targetModel) !== 'claude'
    ) {
      return contents;
    }

    let changed = false;
    const projected = contents.flatMap((content) => {
      if (content.role !== 'model') {
        return [content];
      }
      const signedParts = content.parts.map((part) => {
        const signature = part.thoughtSignature ?? part.thought_signature;
        const family = signature ? classifyThoughtSignatureFamily(signature) : 'unknown';
        return { part, signature, family };
      });
      const hasGeminiSignature = signedParts.some(({ family }) => family === 'gemini');
      const parts = signedParts.flatMap(({ part, signature, family }) => {
        if (
          hasGeminiSignature &&
          !signature &&
          part.thought === true &&
          Object.keys(part).every((key) => key === 'thought' || key === 'text')
        ) {
          changed = true;
          return [];
        }
        if (family !== 'gemini' && family !== 'placeholder') {
          return [part];
        }
        const { thoughtSignature, thought_signature, ...unsigned } = part;
        changed = true;
        const fields = Object.keys(unsigned);
        const privateThought =
          unsigned.thought === true && fields.every((key) => key === 'thought' || key === 'text');
        return privateThought || fields.length === 0 ? [] : [unsigned];
      });
      if (parts.length === 0 && content.parts.length > 0) {
        return [];
      }
      return parts.length !== content.parts.length ||
        parts.some((part, index) => part !== content.parts[index])
        ? [{ ...content, parts }]
        : [content];
    });
    return changed ? projected : contents;
  }
}
