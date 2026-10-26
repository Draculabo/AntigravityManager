import { HttpException, HttpStatus } from '@nestjs/common';
import type { CloudAccount } from '@/modules/cloud-account/types';
import type { AccountLeaseSelectionOptions } from '../interfaces/account-lease-selection-options';
import type {
  ImageAccountSchedulerService,
  ImageAccountPermit,
} from '../image-account-scheduler.service';
import { AccountLeaseSelectionWait } from './account-lease-selection-wait';

export class ImageQueueTimeoutError extends HttpException {
  constructor() {
    super('Image queue wait timed out', HttpStatus.TOO_MANY_REQUESTS);
  }
}
export class ImageAccountUnavailableError extends HttpException {
  constructor() {
    super('No available image accounts', HttpStatus.SERVICE_UNAVAILABLE);
  }
}
export class ImageQueueAbortedError extends Error {
  constructor() {
    super('Image request was aborted');
    this.name = 'AbortError';
  }
}

interface ImageSelectionOwner {
  scheduler: ImageAccountSchedulerService;
  syncAccounts: () => void;
  select: (options: AccountLeaseSelectionOptions) => Promise<CloudAccount | null>;
  timeoutMs: () => number;
  maxSelectionWaitMs: () => number;
}

/** Owns the whole queue lifetime; no permit is held while preparing credentials/quota. */
export class AccountLeaseImageSelectionPolicy {
  private readonly controllers = new Set<AbortController>();
  private stopped = false;
  constructor(private readonly owner: ImageSelectionOwner) {}

  stop(): void {
    this.stopped = true;
    for (const controller of this.controllers) {
      controller.abort(new ImageQueueAbortedError());
    }
  }

  async select(
    options: AccountLeaseSelectionOptions,
  ): Promise<{ token: CloudAccount; permit: ImageAccountPermit }> {
    const controller = new AbortController();
    const signal = controller.signal;
    const deadline = Math.min(
      Date.now() + this.owner.timeoutMs(),
      options.selectionDeadlineMs ?? Infinity,
    );
    const onAbort = () => controller.abort(new ImageQueueAbortedError());
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (this.stopped || options.signal?.aborted) {
      onAbort();
    }
    const timer = setTimeout(
      () => controller.abort(new ImageQueueTimeoutError()),
      Math.max(0, deadline - Date.now()),
    );
    this.controllers.add(controller);
    const check = () => {
      if (signal.aborted) {
        throw signal.reason;
      }
      if (Date.now() >= deadline) {
        throw new ImageQueueTimeoutError();
      }
    };
    const waitBudget =
      options.selectionWaitBudget ??
      new AccountLeaseSelectionWait(
        options.allowSelectionWait === false ? 0 : this.owner.maxSelectionWaitMs(),
        signal,
        deadline,
      );
    const allowance = options.quotaRecoveryAllowance ?? { used: false };
    try {
      check();
      this.owner.syncAccounts();
      while (true) {
        check();
        const busy = new Set<string>();
        while (true) {
          check();
          const selected = await this.waitForSelection(
            this.owner.select({
              ...options,
              signal,
              selectionDeadlineMs: deadline,
              selectionWaitBudget: waitBudget,
              quotaRecoveryAllowance: allowance,
              excludeAccountIds: [...(options.excludeAccountIds ?? []), ...busy],
            }),
            signal,
          );
          check();
          if (!selected) {
            if (busy.size === 0) {
              throw new ImageAccountUnavailableError();
            }
            break;
          }
          const permit = this.owner.scheduler.tryAcquire(selected.id);
          if (permit) {
            try {
              check();
            } catch (error) {
              permit.release();
              throw error;
            }
            return { token: selected, permit };
          }
          busy.add(selected.id);
        }
        await this.owner.scheduler.waitForChange(deadline - Date.now(), signal);
        check();
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      this.controllers.delete(controller);
    }
  }

  private async waitForSelection(
    selection: Promise<CloudAccount | null>,
    signal: AbortSignal,
  ): Promise<CloudAccount | null> {
    return new Promise((resolve, reject) => {
      const finish = (value: CloudAccount | null) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      };
      const fail = (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      };
      const abort = () => fail(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      void selection.then(finish, fail);
      if (signal.aborted) {
        abort();
      }
    });
  }
}
