import { findExistingThoughtRecordIndex } from './thought-store.matching';
import type { ThoughtRecord } from './thought-store.types';
import { mergeThoughtRecordContent } from './thought-record-content';

// Cache eviction keeps SQLite authoritative; this is not a process RSS limit.
const MAX_RETAINED_BYTES = 256 * 1024 * 1024;

export interface MemorySession {
  toolLinkRetryAt?: number;
  olderLookupRetryAt?: number;
  lastAccessed: number;
  persistedAccess: { queuedAt: number } | null;
  loaded: boolean;
  hydrationRetryAt?: number;
  records: ThoughtRecord[];
}

/** Accounts retained strings in UTF-16 plus fixed record/entry overhead. */
export class ThoughtSessionMemory {
  private readonly entries = new Map<string, { session: MemorySession; bytes: number }>();
  private bytes = 0;

  public get size(): number {
    return this.entries.size;
  }
  public snapshot(): { records: number; bytes: number } {
    let records = 0;
    for (const entry of this.entries.values()) {
      records += entry.session.records.length;
    }
    return { records, bytes: this.bytes };
  }

  public get(key: string): MemorySession | undefined {
    return this.entries.get(key)?.session;
  }

  public set(key: string, session: MemorySession): void {
    this.delete(key);
    const bytes =
      128 +
      key.length * 2 +
      session.records.reduce((total, record) => total + recordBytes(record), 0);
    this.entries.set(key, { session, bytes });
    this.bytes += bytes;
  }

  public delete(key: string): void {
    const previous = this.entries.get(key);
    if (previous) {
      this.bytes -= previous.bytes;
      this.entries.delete(key);
    }
  }

  public clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  public *values(): IterableIterator<MemorySession> {
    for (const entry of this.entries.values()) {
      yield entry.session;
    }
  }

  public *[Symbol.iterator](): IterableIterator<[string, MemorySession]> {
    for (const [key, entry] of this.entries) {
      yield [key, entry.session];
    }
  }

  public refresh(key: string, session: MemorySession): void {
    const entry = this.entries.get(key);
    if (entry?.session === session) {
      const bytes =
        128 +
        key.length * 2 +
        session.records.reduce((total, record) => total + recordBytes(record), 0);
      this.bytes += bytes - entry.bytes;
      entry.bytes = bytes;
    }
  }

  public prune(maxSessions: number): void {
    while (this.size > maxSessions || this.bytes > MAX_RETAINED_BYTES) {
      let oldest: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, { session }] of this.entries) {
        if (session.lastAccessed < oldestAt) {
          oldest = key;
          oldestAt = session.lastAccessed;
        }
      }
      if (oldest === undefined) {
        break;
      }
      this.delete(oldest);
    }
  }
}

function recordBytes(record: ThoughtRecord): number {
  const strings = [
    record.thought,
    record.visible,
    record.signature ?? '',
    record.fingerprint,
    record.model ?? '',
    record.sourceFamily ?? '',
    record.operationId ?? '',
    record.causalAnchor ?? '',
    record.captureState ?? '',
    String(record.id),
    record.oversizedSha256 ?? '',
    ...record.toolIds,
    ...record.toolNames,
  ];
  const partBytes = record.partSignatures.reduce(
    (bytes, part) =>
      bytes +
      160 +
      (part.signature?.length ?? 0) * 2 +
      (part.kind === 'tool'
        ? (part.name.length + (part.callId?.length ?? 0) + part.argsDigest.length) * 2
        : 0),
    0,
  );
  return 256 + partBytes + strings.reduce((bytes, value) => bytes + value.length * 2 + 32, 0);
}

/** A cold read snapshot must not overwrite responses captured while it was in flight. */
export function mergeHydratedThoughtRecords(
  persisted: ThoughtRecord[],
  captured: readonly ThoughtRecord[],
): ThoughtRecord[] {
  const records = [...persisted];
  const used = new Set<number>();
  for (const incoming of captured) {
    const index = findExistingThoughtRecordIndex(incoming, persisted, used);
    if (index === null) {
      records.push(incoming);
      continue;
    }
    used.add(index);
    const previous = records[index];
    records[index] = {
      ...previous,
      ...incoming,
      id: previous.id,
      ...mergeThoughtRecordContent(incoming, previous),
    };
  }
  return records;
}
