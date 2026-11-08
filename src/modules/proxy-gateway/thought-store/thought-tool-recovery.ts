import type { ThoughtRecord } from './thought-store.types';
import { expireThoughtToolSignatures } from './thought-tool-links';
import type { ThoughtToolRecoverySnapshot } from './thought-tool-recovery.schema';

/** Durability belongs to retained records; no permanent operation-id index is needed. */
export class ThoughtToolRecovery {
  private readonly persisted = new WeakSet<ThoughtRecord>();

  markPersisted(record: ThoughtRecord): void {
    this.persisted.add(record);
  }

  inherit(previous: ThoughtRecord, next: ThoughtRecord): void {
    if (typeof previous.id === 'number' || this.persisted.has(previous)) {
      this.markPersisted(next);
    }
  }

  apply(
    records: readonly ThoughtRecord[],
    snapshot?: ThoughtToolRecoverySnapshot,
  ): ThoughtRecord[] {
    const permissions = new Map(
      snapshot?.map((entry) => [entry.operationId, new Set(entry.positions)]),
    );
    return records.map((original) => {
      const record = expireThoughtToolSignatures(original);
      const permission = record.operationId ? permissions.get(record.operationId) : undefined;
      if (permission) {
        this.markPersisted(original);
      }
      // An unacknowledged capture may still be queued or may have failed admission.
      // A failed permission read never authorizes a durable tool association.
      const memoryOnly = typeof original.id !== 'number' && !this.persisted.has(original);
      const result =
        !record.operationId || (!permission && memoryOnly)
          ? record
          : {
              ...record,
              partSignatures: record.partSignatures.map((part) =>
                part.kind === 'tool' && !permission?.has(part.position)
                  ? { ...part, signature: null }
                  : part,
              ),
            };
      this.inherit(original, result);
      return result;
    });
  }
}
