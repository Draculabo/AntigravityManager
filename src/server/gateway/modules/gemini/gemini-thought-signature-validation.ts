import { BadRequestException } from '@nestjs/common';

import { areThoughtSignaturesEquivalent } from '../../../../modules/proxy-gateway/antigravity/thought-signature-format';
import type { GeminiPart } from '../../../../modules/proxy-gateway/antigravity/types';

type SignatureAliases = Pick<GeminiPart, 'thoughtSignature' | 'thought_signature'>;

/** Reject ambiguous input before selecting an account, ingesting history or sending HTTP. */
export function assertGeminiThoughtSignatureAliases(
  contents: readonly { parts: readonly SignatureAliases[] }[],
): void {
  for (const [contentIndex, content] of contents.entries()) {
    for (const [partIndex, part] of content.parts.entries()) {
      const { thoughtSignature, thought_signature: snakeSignature } = part;
      if (
        thoughtSignature === undefined ||
        snakeSignature === undefined ||
        areThoughtSignaturesEquivalent(thoughtSignature, snakeSignature)
      ) {
        continue;
      }

      throw new BadRequestException(
        `Conflicting thoughtSignature and thought_signature at contents[${contentIndex}].parts[${partIndex}]. Supply one signature value or equivalent aliases.`,
      );
    }
  }
}
