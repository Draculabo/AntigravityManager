import { hashSessionAnchor } from '../../../server/gateway/common/session-anchor-hash';
import type { GeminiContent } from '../antigravity/types';

/** Business-history prefixes are candidates for a round, never proof of a physical invocation. */
export function thoughtCausalHistory(contents: readonly GeminiContent[]): {
  before: string[];
  after: string;
} {
  const before: string[] = [];
  let digest = hashSessionAnchor(['thought-causal-v1']);
  for (const content of contents) {
    before.push(digest);
    digest = hashSessionAnchor([digest, businessContent(content)]);
  }
  return { before, after: digest };
}

function businessContent(content: GeminiContent) {
  const role = content.role === 'assistant' ? 'model' : content.role;
  const parts = (content.parts ?? []).flatMap((part) => {
    // Retain references to complete business values, including media. The owning
    // canonical hasher frames/chunks strings without copying a serialized request.
    const entries = Object.entries(part).filter(
      ([key]) =>
        key !== 'thoughtSignature' &&
        key !== 'thought_signature' &&
        key !== 'thought' &&
        !(part.thought === true && key === 'text'),
    );
    return entries.length === 0 ? [] : [Object.fromEntries(entries)];
  });
  const fields = Object.fromEntries(
    Object.entries(content).filter(([key]) => key !== 'parts' && key !== 'role'),
  );
  return { ...fields, role, parts };
}
