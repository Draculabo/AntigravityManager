import { isThoughtSignaturePlaceholder } from '../antigravity/ThoughtSignatureCompat';
import type { ThoughtRecordInput } from './thought-store.types';
import { areThoughtRecordModelsCompatible } from './thought-store.model';
import { areThoughtSignaturesEquivalent } from '../antigravity/thought-signature-format';
import {
  sameThoughtTool,
  signaturesEquivalent,
  thoughtSignaturesOf,
} from './thought-part-signatures';

type ThoughtMatchEvidence = Pick<
  ThoughtRecordInput,
  'fingerprint' | 'model' | 'signature' | 'partSignatures' | 'toolIds' | 'toolNames' | 'visible'
> &
  Pick<ThoughtRecordInput, 'operationId' | 'causalAnchor'>;

export function hasThoughtTools(
  record: Pick<ThoughtRecordInput, 'toolIds' | 'toolNames'>,
): boolean {
  return record.toolIds.length > 0 || record.toolNames.length > 0;
}

/** Conflicting opaque values cannot identify one turn, even when a tool ID is reused. */
export function thoughtSignaturesConflict(left: string | null, right: string | null): boolean {
  const isSignature = (value: string | null): value is string =>
    Boolean(value) && !isThoughtSignaturePlaceholder(value);
  return isSignature(left) && isSignature(right) && !areThoughtSignaturesEquivalent(left, right);
}

export function thoughtRecordsConflict(
  left: ThoughtMatchEvidence,
  right: ThoughtMatchEvidence,
): boolean {
  const leftTools = left.partSignatures.filter((part) => part.kind === 'tool');
  const rightTools = right.partSignatures.filter((part) => part.kind === 'tool');
  if (
    leftTools.length &&
    rightTools.length &&
    leftTools.some((tool) => !rightTools.some((other) => sameThoughtTool(tool, other)))
  ) {
    return true;
  }
  if (
    leftTools.some((tool) => {
      const matches = rightTools.filter((other) => sameThoughtTool(tool, other));
      return (
        tool.signature &&
        matches.length > 0 &&
        matches.every((other) => other.signature) &&
        !matches.some((other) => signaturesEquivalent(tool.signature, other.signature))
      );
    })
  ) {
    return true;
  }
  const leftThoughts = left.partSignatures.filter((part) => part.kind === 'thought');
  const rightThoughts = right.partSignatures.filter((part) => part.kind === 'thought');
  if (
    leftThoughts.some((part) => {
      if (!part.signature) {
        return false;
      }
      const matches = rightThoughts.filter(
        (other) => part.start === other.start && part.end === other.end,
      );
      return (
        matches.length > 0 &&
        matches.every((other) => other.signature) &&
        !matches.some((other) => signaturesEquivalent(part.signature, other.signature))
      );
    })
  ) {
    return true;
  }
  const leftSignatures = thoughtSignaturesOf(left);
  const rightSignatures = thoughtSignaturesOf(right);
  return (
    thoughtSignaturesConflict(left.signature, right.signature) ||
    (leftSignatures.length > 0 &&
      rightSignatures.length > 0 &&
      !leftSignatures.some((value) =>
        rightSignatures.some((other) => signaturesEquivalent(value, other)),
      ))
  );
}

/** Array position and previously consumed candidates cannot resolve ambiguous ownership. */
export function findExistingThoughtRecordIndex(
  incoming: ThoughtMatchEvidence,
  existing: readonly ThoughtMatchEvidence[],
  used: ReadonlySet<number>,
  mode: 'ingest' | 'restore' = 'ingest',
): number | null {
  const candidates = existing
    .map((record, index) => ({ index, record }))
    .filter(
      ({ record }) =>
        areThoughtRecordModelsCompatible(record, incoming) &&
        (mode === 'restore' ||
          !incoming.operationId ||
          record.operationId === incoming.operationId) &&
        (!incoming.causalAnchor ||
          !record.causalAnchor ||
          record.causalAnchor === incoming.causalAnchor) &&
        !thoughtRecordsConflict(incoming, record),
    );
  if (mode === 'restore' && incoming.causalAnchor) {
    const incomingTools = incoming.partSignatures.filter((part) => part.kind === 'tool');
    const owned = candidates.filter(({ record }) => {
      if (!record.causalAnchor) {
        return true;
      }
      const tools = record.partSignatures.filter((part) => part.kind === 'tool');
      return (
        tools.length === incomingTools.length &&
        incomingTools.every(
          (tool) => tools.filter((candidate) => sameThoughtTool(tool, candidate)).length === 1,
        )
      );
    });
    candidates.splice(0, candidates.length, ...owned);
  }
  const select = (matches: typeof candidates): number | null => {
    const index = matches.length === 1 ? matches[0].index : null;
    return index !== null && !used.has(index) ? index : null;
  };
  const incomingSignatures = thoughtSignaturesOf(incoming);
  if (mode === 'ingest' && incoming.operationId) {
    return select(candidates);
  }
  if (incomingSignatures.length > 0) {
    const signed = candidates.filter(({ record }) =>
      incomingSignatures.some((value) =>
        thoughtSignaturesOf(record).some((other) => signaturesEquivalent(value, other)),
      ),
    );
    if (signed.length > 0 || mode === 'restore') {
      return select(signed);
    }
  }
  const sameCategory = candidates.filter(
    ({ record }) => hasThoughtTools(record) === hasThoughtTools(incoming),
  );
  if (incoming.toolIds.length > 0) {
    const identified = sameCategory.filter(({ record }) =>
      incoming.toolIds.some((id) => record.toolIds.includes(id)),
    );
    const exact = identified.filter(({ record }) => record.fingerprint === incoming.fingerprint);
    if (exact.length > 0) {
      return select(exact);
    }
    if (identified.length > 0) {
      return select(identified);
    }
  }
  const exact = sameCategory.filter(({ record }) => record.fingerprint === incoming.fingerprint);
  if (exact.length > 0) {
    return select(exact);
  }
  if (mode === 'restore' && !hasThoughtTools(incoming) && incoming.visible) {
    return select(sameCategory.filter(({ record }) => record.visible === incoming.visible));
  }
  return null;
}

export function isStrongerThoughtRecord(
  incoming: ThoughtRecordInput,
  existing: ThoughtRecordInput,
): boolean {
  return (
    Buffer.byteLength(incoming.thought, 'utf8') > Buffer.byteLength(existing.thought, 'utf8') ||
    incoming.partSignatures.filter((part) => part.signature).length >
      existing.partSignatures.filter((part) => part.signature).length
  );
}
