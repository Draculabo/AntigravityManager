import { logger } from '@/shared/logging/logger';
import { readJsonFileSync, writeJsonFileAtomic } from './atomic-json-file';

const STORE_FORMAT_VERSION = 1;

export interface DurableRecord<TValue> {
  key: string;
  updatedAt: number;
  value: TValue;
}

export interface DurableRecordStoreOptions<TValue> {
  /** Absolute path of the backing file. Omit for an in-memory-only store. */
  filePath?: string;
  /** Hard ceiling on retained records; the least recently written go first. */
  maxEntries: number;
  /** Maximum age of a record, measured from its last write or read. */
  ttlMs: number;
  /**
   * Validates one value read back from disk. Returning `null` drops the record,
   * which is how a partially understood or hand-edited file is survived.
   */
  revive?: (value: unknown) => TValue | null;
}

interface DurableRecordFile<TValue> {
  version: number;
  entries: Array<DurableRecord<TValue>>;
}

/**
 * Keyed JSON state that outlives the process.
 *
 * Reads and writes are synchronous because the proxy request path is
 * synchronous; the disk write is coalesced and atomic, so a burst of updates
 * costs one rename and a kill mid-write cannot corrupt the file. Records are
 * bounded by both age and count so user content never grows without limit.
 *
 * Without `filePath` the store is a plain bounded in-memory map, which is what
 * ephemeral per-connection state and unit tests want.
 */
export class DurableRecordStore<TValue> {
  private readonly records = new Map<string, DurableRecord<TValue>>();
  private hydrated = false;
  private persistScheduled = false;
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly options: DurableRecordStoreOptions<TValue>) {}

  public get(key: string, now: number = Date.now()): TValue | null {
    this.hydrate();
    const record = this.records.get(key);
    if (!record) {
      return null;
    }
    if (this.isExpired(record, now)) {
      this.records.delete(key);
      this.schedulePersist();
      return null;
    }

    // Re-insert so map order stays least-recently-written first for eviction.
    record.updatedAt = now;
    this.records.delete(key);
    this.records.set(key, record);
    this.schedulePersist();
    return record.value;
  }

  public set(key: string, value: TValue, now: number = Date.now()): void {
    this.hydrate();
    this.evictExpired(now);
    this.records.delete(key);
    this.records.set(key, { key, updatedAt: now, value });
    this.evictOverflow();
    this.schedulePersist();
  }

  public delete(key: string): boolean {
    this.hydrate();
    const deleted = this.records.delete(key);
    if (deleted) {
      this.schedulePersist();
    }
    return deleted;
  }

  public clear(): void {
    this.hydrate();
    this.records.clear();
    this.schedulePersist();
  }

  /** Live, non-expired records, least recently written first. */
  public entries(now: number = Date.now()): Array<DurableRecord<TValue>> {
    this.hydrate();
    if (this.evictExpired(now)) {
      this.schedulePersist();
    }
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  public get size(): number {
    this.hydrate();
    return this.records.size;
  }

  /** Resolves once every write scheduled so far has reached the disk. */
  public async flush(): Promise<void> {
    let awaited: Promise<void> | null = null;
    while (awaited !== this.writeQueue) {
      awaited = this.writeQueue;
      await awaited;
    }
  }

  private isExpired(record: DurableRecord<TValue>, now: number): boolean {
    return now - record.updatedAt >= this.options.ttlMs;
  }

  private evictExpired(now: number): boolean {
    let changed = false;
    for (const [key, record] of this.records) {
      if (this.isExpired(record, now)) {
        this.records.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  private evictOverflow(): void {
    while (this.records.size > this.options.maxEntries) {
      const oldestKey = this.records.keys().next().value;
      if (oldestKey === undefined) {
        return;
      }
      this.records.delete(oldestKey);
    }
  }

  private hydrate(): void {
    if (this.hydrated) {
      return;
    }
    this.hydrated = true;
    if (!this.options.filePath) {
      return;
    }

    const parsed = readJsonFileSync(this.options.filePath) as Partial<
      DurableRecordFile<unknown>
    > | null;
    if (!parsed || parsed.version !== STORE_FORMAT_VERSION || !Array.isArray(parsed.entries)) {
      return;
    }

    const now = Date.now();
    const revived: Array<DurableRecord<TValue>> = [];
    for (const entry of parsed.entries) {
      const record = this.reviveRecord(entry, now);
      if (record) {
        revived.push(record);
      }
    }

    revived.sort((left, right) => left.updatedAt - right.updatedAt);
    for (const record of revived) {
      this.records.set(record.key, record);
    }
    this.evictOverflow();
    if (this.records.size !== parsed.entries.length) {
      this.schedulePersist();
    }
  }

  private reviveRecord(entry: unknown, now: number): DurableRecord<TValue> | null {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return null;
    }
    const key = Reflect.get(entry, 'key');
    const updatedAt = Reflect.get(entry, 'updatedAt');
    if (
      typeof key !== 'string' ||
      !key ||
      typeof updatedAt !== 'number' ||
      !Number.isFinite(updatedAt)
    ) {
      return null;
    }
    if (now - updatedAt >= this.options.ttlMs) {
      return null;
    }

    const rawValue = Reflect.get(entry, 'value');
    const value = this.options.revive ? this.options.revive(rawValue) : (rawValue as TValue);
    if (value === null || value === undefined) {
      return null;
    }
    return { key, updatedAt, value };
  }

  private schedulePersist(): void {
    const { filePath } = this.options;
    if (!filePath) {
      return;
    }
    if (this.persistScheduled) {
      return;
    }

    // One pending write at a time: it snapshots whatever the map holds when it
    // runs, so every change made while it waited is already in that snapshot.
    this.persistScheduled = true;
    this.writeQueue = this.writeQueue.then(async () => {
      this.persistScheduled = false;

      const snapshot: DurableRecordFile<TValue> = {
        version: STORE_FORMAT_VERSION,
        entries: [...this.records.values()],
      };
      try {
        await writeJsonFileAtomic(filePath, snapshot);
      } catch (error) {
        // Losing durable state must never fail an otherwise valid request.
        logger.warn(`Failed to persist durable state to ${filePath}`, error);
      }
    });
  }
}
