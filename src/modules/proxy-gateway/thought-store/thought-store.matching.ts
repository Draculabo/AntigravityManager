import type { ThoughtRecordInput } from './thought-store.types';

export function hasThoughtTools(record: ThoughtRecordInput): boolean {
  return record.toolIds.length > 0 || record.toolNames.length > 0;
}

/** Match inbound history against the pre-existing session, newest first and at most once. */
export function findExistingThoughtRecordIndex(
  incoming: ThoughtRecordInput,
  existing: readonly ThoughtRecordInput[],
  used: ReadonlySet<number>,
): number | null {
  if (incoming.toolIds.length > 0) {
    for (let index = existing.length - 1; index >= 0; index--) {
      if (!used.has(index) && incoming.toolIds.some((id) => existing[index].toolIds.includes(id))) {
        return index;
      }
    }
  }

  const incomingHasTools = hasThoughtTools(incoming);
  for (let index = existing.length - 1; index >= 0; index--) {
    const record = existing[index];
    if (
      !used.has(index) &&
      record.fingerprint === incoming.fingerprint &&
      hasThoughtTools(record) === incomingHasTools
    ) {
      return index;
    }
  }
  return null;
}

export function isStrongerThoughtRecord(
  incoming: ThoughtRecordInput,
  existing: ThoughtRecordInput,
): boolean {
  return (
    Buffer.byteLength(incoming.thought, 'utf8') > Buffer.byteLength(existing.thought, 'utf8') ||
    Buffer.byteLength(incoming.signature ?? '', 'utf8') >
      Buffer.byteLength(existing.signature ?? '', 'utf8')
  );
}
