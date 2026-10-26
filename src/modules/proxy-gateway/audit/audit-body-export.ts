import type {
  TrafficAuditBodyDescriptor,
  TrafficAuditBodyPage,
  TrafficAuditBodyPageInput,
} from './traffic-audit.types';

function verifySnapshot(
  previous: TrafficAuditBodyDescriptor | null,
  current: TrafficAuditBodyDescriptor | null,
): TrafficAuditBodyDescriptor {
  if (
    !current ||
    current.state === 'writing' ||
    current.state === 'expired' ||
    (previous &&
      (current.id !== previous.id ||
        current.state !== previous.state ||
        current.storedBytes !== previous.storedBytes ||
        current.logicalBytes !== previous.logicalBytes ||
        current.chunkCount !== previous.chunkCount ||
        current.sha256 !== previous.sha256 ||
        current.sha256Scope !== previous.sha256Scope))
  ) {
    throw new Error('Saved audit body changed or is unavailable during export');
  }
  return current;
}

/** Complete the bounded saved snapshot before allowing an atomic file export to commit. */
export async function* auditBodyForExport(
  bodyId: string,
  read: (input: TrafficAuditBodyPageInput) => Promise<TrafficAuditBodyPage | null>,
): AsyncGenerator<string> {
  let cursor = 0;
  let bytes = 0;
  let snapshot: TrafficAuditBodyDescriptor | null = null;
  while (true) {
    const page = await read({ bodyId, cursor, limitBytes: 256 * 1024 });
    snapshot = verifySnapshot(snapshot, page?.body ?? null);
    if (!page) {
      throw new Error('Saved audit body is unavailable');
    }
    for (const chunk of page.chunks) {
      bytes += Buffer.byteLength(chunk.data, 'utf8');
      yield chunk.data;
    }
    if (page.complete) {
      break;
    }
    if (page.nextCursor === null || page.nextCursor <= cursor) {
      throw new Error('Audit export cursor did not advance');
    }
    cursor = page.nextCursor;
  }
  // The consumer may have yielded to filesystem writes after the final chunk.
  verifySnapshot(snapshot, (await read({ bodyId, cursor: 0, limitBytes: 1 }))?.body ?? null);
  if (bytes !== snapshot.storedBytes) {
    throw new Error('Saved audit body export is incomplete');
  }
}
