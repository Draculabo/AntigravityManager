import type { ThoughtRecord } from './thought-store.types';
import { thoughtHydrationCancelled } from './thought-hydration-requests';

const MAX_WAITING_LOADS = 64;
const MAX_WAIT_MS = 5_000;

export class ThoughtHydrationAdmissionError extends Error {
  public constructor(public readonly reason: 'capacity' | 'timeout' | 'closed') {
    super(`Thought Store cold hydration admission ${reason}`);
    this.name = 'ThoughtHydrationAdmissionError';
  }
}

interface WaitingLoad {
  deadlineAt: number;
  load: () => Promise<ThoughtRecord[]>;
  resolve: (records: ThoughtRecord[]) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout | null;
  detach: () => void;
}

/** A cold read may return 64 MiB despite its tiny command; keep management slots available. */
export class ThoughtHydrationQueue {
  private readonly waiting: WaitingLoad[] = [];
  private active = false;
  private paused = false;

  public acceptsWork(): boolean {
    return !this.paused;
  }

  public run(load: () => Promise<ThoughtRecord[]>, signal?: AbortSignal): Promise<ThoughtRecord[]> {
    if (signal?.aborted) {
      return Promise.reject(thoughtHydrationCancelled());
    }
    if (this.paused) {
      return Promise.reject(new ThoughtHydrationAdmissionError('closed'));
    }
    if (this.waiting.length >= MAX_WAITING_LOADS) {
      return Promise.reject(new ThoughtHydrationAdmissionError('capacity'));
    }
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) {
          this.waiting.splice(index, 1);
        }
        if (entry.timer) {
          clearTimeout(entry.timer);
        }
        entry.detach();
        reject(thoughtHydrationCancelled());
      };
      const entry: WaitingLoad = {
        deadlineAt: performance.now() + MAX_WAIT_MS,
        load,
        resolve,
        reject,
        timer: null,
        detach: () => signal?.removeEventListener('abort', cancel),
      };
      entry.timer = setTimeout(() => {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) {
          this.waiting.splice(index, 1);
          entry.detach();
          reject(new ThoughtHydrationAdmissionError('timeout'));
        }
      }, MAX_WAIT_MS);
      entry.timer.unref();
      this.waiting.push(entry);
      signal?.addEventListener('abort', cancel, { once: true });
      this.pump();
    });
  }

  public pause(): void {
    this.paused = true;
    for (const entry of this.waiting.splice(0)) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      entry.reject(new ThoughtHydrationAdmissionError('closed'));
      entry.detach();
    }
  }

  public resume(): void {
    this.paused = false;
    this.pump();
  }

  private pump(): void {
    if (this.paused || this.active) {
      return;
    }
    while (this.waiting.length > 0) {
      const entry = this.waiting.shift();
      if (!entry) {
        return;
      }
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      // A blocked event loop can postpone the timer; never issue an already-expired read.
      if (performance.now() >= entry.deadlineAt) {
        entry.reject(new ThoughtHydrationAdmissionError('timeout'));
        entry.detach();
        continue;
      }
      this.active = true;
      void this.execute(entry);
      return;
    }
  }

  private async execute(entry: WaitingLoad): Promise<void> {
    try {
      entry.resolve(await entry.load());
    } catch (error) {
      entry.reject(error);
    } finally {
      entry.detach();
      this.active = false;
      if (!this.paused && this.waiting.length > 0) {
        // Let restoration and socket/management work consume this reply before the next body.
        setImmediate(() => this.pump());
      }
    }
  }
}
