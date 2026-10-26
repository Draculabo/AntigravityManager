import { HttpException, HttpStatus } from '@nestjs/common';
import { throwIfRequestAborted } from './request-cancellation';
import {
  AggregationByteAccounting,
  aggregationByteAccounting,
  type AggregationByteAccount,
  type AggregationByteSnapshot,
} from './aggregation-byte-accounting';

export class AggregationAdmissionError extends HttpException {
  constructor(reason: 'full' | 'timeout') {
    super(
      reason === 'full'
        ? 'Local stream aggregation queue is full'
        : 'Local stream aggregation wait timed out',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal: AbortSignal | undefined;
  cancel: () => void;
  timer: NodeJS.Timeout;
  account: AggregationByteAccount;
  requestBytes: number;
}

/** FIFO admission before upstream creation; entries own callbacks, never request bodies or tokens. */
export class AggregationAdmission {
  private active = 0;
  private readonly waiting = new Set<Waiter>();

  constructor(
    private readonly capacity = 2,
    private readonly maxWaiting = 8,
    private readonly waitMs = 30_000,
    private readonly bytes: AggregationByteAccounting = aggregationByteAccounting,
  ) {}

  get snapshot(): { active: number; waiting: number } {
    return { active: this.active, waiting: this.waiting.size };
  }

  get byteSnapshot(): AggregationByteSnapshot {
    return this.bytes.snapshot;
  }

  async acquire(signal?: AbortSignal, requestBytes = 0): Promise<() => void> {
    throwIfRequestAborted(signal);
    if (this.active < this.capacity && this.waiting.size === 0) {
      return this.grant(this.bytes.open(), requestBytes);
    }
    if (this.waiting.size >= this.maxWaiting) {
      throw new AggregationAdmissionError('full');
    }
    return new Promise((resolve, reject) => {
      const account = this.bytes.open();
      account.set('waitingRequestBytes', requestBytes);
      const cancel = (): void => {
        if (!this.remove(entry)) {
          return;
        }
        account.close();
        reject(new DOMException('Upstream request cancelled', 'AbortError'));
      };
      const entry: Waiter = {
        resolve,
        reject,
        signal,
        cancel,
        account,
        requestBytes,
        timer: setTimeout(() => {
          if (this.remove(entry)) {
            account.close();
            reject(new AggregationAdmissionError('timeout'));
          }
        }, this.waitMs),
      };
      this.waiting.add(entry);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) {
        cancel();
      }
    });
  }

  private remove(entry: Waiter): boolean {
    if (!this.waiting.delete(entry)) {
      return false;
    }
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.cancel);
    return true;
  }

  private grant(account: AggregationByteAccount, requestBytes: number): () => void {
    account.set('waitingRequestBytes', 0);
    account.set('activeRequestBytes', requestBytes);
    this.active++;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      account.close();
      this.active--;
      for (const entry of this.waiting) {
        if (this.active >= this.capacity) {
          break;
        }
        if (entry.signal?.aborted) {
          entry.cancel();
        } else {
          this.remove(entry);
          entry.resolve(this.grant(entry.account, entry.requestBytes));
        }
      }
    };
  }
}

export const aggregationAdmission = new AggregationAdmission();
