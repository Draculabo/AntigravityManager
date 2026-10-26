import { isPlaceholderThought } from './thought-placeholder';
import type { ThoughtRecordInput } from './thought-store.types';
import { sameThoughtTool, type ThoughtPartSignature } from './thought-part-signatures';

/**
 * Text and its ranges are one value. Partial unsigned replays may contribute tool
 * identities but cannot detach existing reasoning signatures from their text.
 */
export function mergeThoughtRecordContent(
  incoming: Pick<ThoughtRecordInput, 'thought' | 'signature' | 'partSignatures'>,
  existing: Pick<ThoughtRecordInput, 'thought' | 'signature' | 'partSignatures'>,
): Pick<ThoughtRecordInput, 'thought' | 'signature' | 'partSignatures'> {
  const source =
    (!isPlaceholderThought(incoming.thought) &&
      (isPlaceholderThought(existing.thought) ||
        Buffer.byteLength(incoming.thought, 'utf8') >
          Buffer.byteLength(existing.thought, 'utf8'))) ||
    (incoming.thought === existing.thought &&
      incoming.partSignatures.filter((part) => part.kind === 'thought' && part.signature).length >
        existing.partSignatures.filter((part) => part.kind === 'thought' && part.signature).length)
      ? incoming
      : existing;
  const previousTools = existing.partSignatures.filter((part) => part.kind === 'tool');
  const incomingTools = incoming.partSignatures.filter((part) => part.kind === 'tool');
  const tools = incomingTools.length
    ? incomingTools.map((part) => {
        if (part.signature) {
          return part;
        }
        const matches = previousTools.filter((previous) => sameThoughtTool(part, previous));
        const claims = incomingTools.filter((other) => sameThoughtTool(part, other));
        return matches.length === 1 && claims.length === 1
          ? { ...part, signature: matches[0].signature }
          : part;
      })
    : previousTools;
  // Tool positions identify no owner and are not used during restoration.
  // Reserve their positions after reasoning to keep one valid metadata layout.
  const sourceThought = source.thought;
  const other = source === incoming ? existing : incoming;
  const reasoning = source.partSignatures
    .filter((part) => part.kind === 'thought')
    .map((part) => {
      if (part.signature) {
        return part;
      }
      const text = sourceThought.slice(part.start, part.end);
      const sourceClaims = source.partSignatures.filter(
        (candidate) =>
          candidate.kind === 'thought' &&
          sourceThought.slice(candidate.start, candidate.end) === text,
      );
      const matches = other.partSignatures.filter(
        (candidate): candidate is Extract<ThoughtPartSignature, { kind: 'thought' }> =>
          candidate.kind === 'thought' &&
          Boolean(candidate.signature) &&
          other.thought.slice(candidate.start, candidate.end) === text,
      );
      const otherClaims = other.partSignatures.filter(
        (candidate) =>
          candidate.kind === 'thought' &&
          other.thought.slice(candidate.start, candidate.end) === text,
      );
      return sourceClaims.length === 1 && otherClaims.length === 1 && matches.length === 1
        ? { ...part, signature: matches[0].signature }
        : part;
    });
  const occupied = new Set(reasoning.map((part) => part.position));
  let next = 0;
  const positioned = tools.map((tool) => {
    let position = tool.position;
    if (occupied.has(position)) {
      while (occupied.has(next)) {
        next++;
      }
      position = next;
    }
    occupied.add(position);
    return { ...tool, position };
  });
  return {
    thought: source.thought,
    signature: source.signature,
    partSignatures: [...reasoning, ...positioned],
  };
}
