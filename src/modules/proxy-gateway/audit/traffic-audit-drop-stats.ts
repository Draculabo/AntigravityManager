import type { BoundedSqliteWorker } from '@/shared/persistence/sqlite-worker/bounded-sqlite-worker';
import type { TrafficClass } from './traffic-classifier';

interface PendingDropStats {
  bytes: number;
  count: number;
  flushing: Promise<void> | null;
  reason: string;
  sequence: number;
}

/** Owns the pending baseline independently of the worker's weighted command order. */
export class TrafficAuditDropStats {
  private readonly pending = new Map<TrafficClass, PendingDropStats>();
  private sequence = 0;
  private resetTail: Promise<void> = Promise.resolve();
  private resetting: {
    trafficClass: TrafficClass | null;
    buckets: Map<TrafficClass, PendingDropStats>;
  } | null = null;

  public get count(): number {
    return this.buckets().reduce((total, bucket) => total + bucket.count, 0);
  }

  public get lastReason(): string | null {
    let latest: PendingDropStats | undefined;
    for (const bucket of this.buckets()) {
      if (bucket.count > 0 && (!latest || bucket.sequence > latest.sequence)) {
        latest = bucket;
      }
    }
    return latest?.reason ?? null;
  }

  public record(reason: string, bytes: number, trafficClass: TrafficClass): void {
    const bucket = this.pending.get(trafficClass) ?? {
      bytes: 0,
      count: 0,
      flushing: null,
      reason,
      sequence: 0,
    };
    bucket.count += 1;
    bucket.bytes += bytes;
    bucket.reason = reason;
    bucket.sequence = ++this.sequence;
    this.pending.set(trafficClass, bucket);
  }

  public flush(worker: BoundedSqliteWorker): void {
    for (const [trafficClass, bucket] of this.pending) {
      if (
        bucket.count <= 0 ||
        bucket.flushing ||
        (this.resetting &&
          (!this.resetting.trafficClass || this.resetting.trafficClass === trafficClass))
      ) {
        continue;
      }
      const count = bucket.count;
      const droppedBytes = bucket.bytes;
      let finish: () => void = () => {};
      bucket.flushing = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const settle = () => {
        bucket.flushing = null;
        finish();
      };
      let accepted = false;
      try {
        accepted = worker.tryWrite(
          {
            operation: 'drop',
            payload: {
              count,
              droppedBytes,
              lastSeen: Date.now(),
              reason: bucket.reason,
              trafficClass,
            },
          },
          {
            onFailure: settle,
            onSuccess: () => {
              bucket.count -= count;
              bucket.bytes -= droppedBytes;
              settle();
            },
            priority: 'background',
          },
        );
      } finally {
        if (!accepted) {
          settle();
        }
      }
    }
  }

  public reset<T>(trafficClass: TrafficClass | null, mutate: () => Promise<T>): Promise<T> {
    const task = this.resetTail.then(() => this.performReset(trafficClass, mutate));
    // Alternate management entry points share the same baseline transition. A failed
    // transition restores its pending counts before a later transition starts.
    this.resetTail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async performReset<T>(
    trafficClass: TrafficClass | null,
    mutate: () => Promise<T>,
  ): Promise<T> {
    const buckets = new Map<TrafficClass, PendingDropStats>();
    for (const [key, bucket] of this.pending) {
      if (!trafficClass || key === trafficClass) {
        buckets.set(key, bucket);
        this.pending.delete(key);
      }
    }
    this.resetting = { trafficClass, buckets };
    let completed = false;
    try {
      // Background writes may be overtaken by control commands. Wait for their
      // acknowledgements before deleting persisted counts. New drops stay pending
      // in separate buckets until this transition finishes.
      await Promise.all([...buckets.values()].map((bucket) => bucket.flushing));
      const result = await mutate();
      completed = true;
      return result;
    } finally {
      if (!completed) {
        for (const [key, bucket] of buckets) {
          const current = this.pending.get(key);
          if (!current) {
            this.pending.set(key, bucket);
          } else {
            current.count += bucket.count;
            current.bytes += bucket.bytes;
            if (bucket.sequence > current.sequence) {
              current.reason = bucket.reason;
              current.sequence = bucket.sequence;
            }
          }
        }
      }
      this.resetting = null;
    }
  }

  private buckets(): PendingDropStats[] {
    return [...this.pending.values(), ...(this.resetting?.buckets.values() ?? [])];
  }
}
