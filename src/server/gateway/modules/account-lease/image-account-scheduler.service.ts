import { Injectable } from '@nestjs/common';
import { getServerConfig } from '@/server/server-config';

const DEFAULT_PER_ACCOUNT_CONCURRENCY = 4;
const ACCOUNT_RESELECT_INTERVAL_MS = 250;

interface ImageAccountState {
  enabled: boolean;
  inUse: number;
}

export type ImageSchedulerWaitResult = 'changed' | 'elapsed' | 'aborted';

export class ImageAccountPermit {
  private released = false;

  constructor(
    public readonly accountId: string,
    private readonly releasePermit: (accountId: string) => void,
  ) {}

  release(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    this.releasePermit(this.accountId);
  }
}

@Injectable()
export class ImageAccountSchedulerService {
  private readonly accounts = new Map<string, ImageAccountState>();
  private readonly changeListeners = new Set<() => void>();
  private readonly perAccountConcurrency: number;

  constructor() {
    const configured = getServerConfig()?.image_scheduler.per_account_concurrency;
    this.perAccountConcurrency =
      Number.isInteger(configured) && (configured ?? -1) >= 0
        ? (configured as number)
        : DEFAULT_PER_ACCOUNT_CONCURRENCY;
  }

  tryAcquire(accountId: string): ImageAccountPermit | null {
    const account = this.accounts.get(accountId);
    if (!account?.enabled || account.inUse >= this.perAccountConcurrency) {
      return null;
    }

    account.inUse += 1;
    return new ImageAccountPermit(accountId, (releasedAccountId) => {
      this.release(releasedAccountId);
    });
  }

  syncAccounts(accountIds: Iterable<string>): void {
    const enabledAccountIds = new Set(accountIds);
    let changed = false;
    for (const [accountId, account] of this.accounts) {
      const enabled = enabledAccountIds.has(accountId);
      if (!enabled && account.inUse === 0) {
        this.accounts.delete(accountId);
        changed = true;
        continue;
      }
      if (account.enabled !== enabled) {
        account.enabled = enabled;
        changed = true;
      }
    }
    for (const accountId of enabledAccountIds) {
      const current = this.accounts.get(accountId);
      if (current) {
        if (!current.enabled) {
          current.enabled = true;
          changed = true;
        }
      } else {
        this.accounts.set(accountId, { enabled: true, inUse: 0 });
        changed = true;
      }
    }
    for (const [accountId, account] of this.accounts) {
      if (!account.enabled && account.inUse === 0) {
        this.accounts.delete(accountId);
        changed = true;
      }
    }
    if (changed) {
      this.notifyChange();
    }
  }

  waitForChange(remainingMs: number, signal?: AbortSignal): Promise<ImageSchedulerWaitResult> {
    if (remainingMs <= 0) {
      return Promise.resolve('elapsed');
    }
    if (signal?.aborted) {
      return Promise.resolve('aborted');
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: ImageSchedulerWaitResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.changeListeners.delete(onChange);
        signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onChange = (): void => finish('changed');
      const onAbort = (): void => finish('aborted');
      const timer = setTimeout(
        () => finish('elapsed'),
        Math.min(remainingMs, ACCOUNT_RESELECT_INTERVAL_MS),
      );

      this.changeListeners.add(onChange);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  getAvailableSlots(): number {
    let available = 0;
    for (const account of this.accounts.values()) {
      if (account.enabled) {
        available += Math.max(0, this.perAccountConcurrency - account.inUse);
      }
    }
    return available;
  }

  getInUseFor(accountId: string): number {
    return this.accounts.get(accountId)?.inUse ?? 0;
  }

  private release(accountId: string): void {
    const account = this.accounts.get(accountId);
    if (!account) {
      return;
    }
    account.inUse = Math.max(0, account.inUse - 1);
    if (!account.enabled && account.inUse === 0) {
      this.accounts.delete(accountId);
    }
    this.notifyChange();
  }

  private notifyChange(): void {
    const listeners = Array.from(this.changeListeners);
    for (const listener of listeners) {
      listener();
    }
  }
}
