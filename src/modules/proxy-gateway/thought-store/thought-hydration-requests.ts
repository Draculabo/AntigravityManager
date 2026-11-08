import type { ThoughtRecord } from './thought-store.types';

export function thoughtHydrationCancelled(): Error {
  return new DOMException('Thought restoration cancelled', 'AbortError');
}

interface Subscriber<TResult> {
  resolve: (records: TResult) => void;
  reject: (error: unknown) => void;
  detach: () => void;
}

interface HydrationJob<TResult> {
  controller: AbortController;
  subscribers: Set<Subscriber<TResult>>;
}

/** Cancellation belongs to each requester; shared reads survive while another requester waits. */
export class ThoughtHydrationRequests<TResult = ThoughtRecord[]> {
  private readonly jobs = new Map<string, HydrationJob<TResult>>();
  private readonly pending = new Set<Promise<void>>();

  public run(
    key: string,
    load: (signal: AbortSignal) => Promise<TResult>,
    signal?: AbortSignal,
  ): Promise<TResult> {
    if (signal?.aborted) {
      return Promise.reject(thoughtHydrationCancelled());
    }
    let job = this.jobs.get(key);
    const fresh = !job;
    if (!job) {
      job = { controller: new AbortController(), subscribers: new Set() };
      this.jobs.set(key, job);
    }
    const current = job;
    const result = new Promise<TResult>((resolve, reject) => {
      const cancel = () => {
        subscriber.detach();
        current.subscribers.delete(subscriber);
        reject(thoughtHydrationCancelled());
        if (current.subscribers.size === 0) {
          if (this.jobs.get(key) === current) {
            this.jobs.delete(key);
          }
          current.controller.abort();
        }
      };
      const subscriber: Subscriber<TResult> = {
        resolve,
        reject,
        detach: () => signal?.removeEventListener('abort', cancel),
      };
      current.subscribers.add(subscriber);
      signal?.addEventListener('abort', cancel, { once: true });
    });
    if (fresh) {
      const task = this.execute(key, current, load);
      this.pending.add(task);
      void task.finally(() => this.pending.delete(task));
    }
    return result;
  }

  public cancel(key: string): void {
    const job = this.jobs.get(key);
    if (!job) {
      return;
    }
    for (const subscriber of job.subscribers) {
      subscriber.detach();
      subscriber.reject(thoughtHydrationCancelled());
    }
    job.subscribers.clear();
    job.controller.abort();
    this.jobs.delete(key);
  }
  public cancelAll(): void {
    for (const job of this.jobs.values()) {
      for (const subscriber of job.subscribers) {
        subscriber.detach();
        subscriber.reject(thoughtHydrationCancelled());
      }
      job.subscribers.clear();
      job.controller.abort();
    }
    this.jobs.clear();
  }

  public waitForIdle(): Promise<unknown> {
    return Promise.all([...this.pending]);
  }

  private async execute(
    key: string,
    job: HydrationJob<TResult>,
    load: (signal: AbortSignal) => Promise<TResult>,
  ): Promise<void> {
    try {
      const records = await load(job.controller.signal);
      for (const subscriber of job.subscribers) {
        subscriber.detach();
        subscriber.resolve(records);
      }
    } catch (error) {
      for (const subscriber of job.subscribers) {
        subscriber.detach();
        subscriber.reject(error);
      }
    } finally {
      job.subscribers.clear();
      if (this.jobs.get(key) === job) {
        this.jobs.delete(key);
      }
    }
  }
}
