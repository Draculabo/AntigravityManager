import type { CloudAccount } from '@/modules/cloud-account/types';
import { UpstreamRequestError } from '../../common/exceptions/upstream-request.exception';
import { throwIfRequestAborted } from '../../common/request-cancellation';
import {
  hasExplicitQuotaExhaustedSignal,
  parseRetryDelay,
  STRUCTURED_GRACE_RETRY_BUFFER_MS,
  TEXT_GRACE_RETRY_BUFFER_MS,
} from './rate-limit-tracker.service';
import type { OrdinaryAccountRotation } from './ordinary-account-rotation';

interface OrdinaryRetryLease {
  getNextToken(options: {
    model: string;
    effort?: string;
    physicalTarget?: boolean;
    sessionKey?: string;
    excludeAccountIds: string[];
    allowSelectionWait?: boolean;
    signal?: AbortSignal;
    selectionDeadlineMs?: number;
  }): Promise<CloudAccount | null>;
  /** Null excludes an account/pool from bounded waiting; zero means immediately eligible. */
  getOrdinaryRetryWaitMs(options: {
    model: string;
    effort?: string;
    physicalTarget?: boolean;
    accountId?: string;
  }): number | null;
}

/** Normal sends and round exclusions belong to one request; grace is a separate allowance. */
export class OrdinaryRetryRounds {
  private poolSize = 1;
  private normalSends = 0;
  private maxNormalSends = 3;
  private round = 0;
  private readonly roundAccountIds = new Set<string>();
  private lastError: unknown;
  private readonly deadlineMs: number;

  constructor(timeoutMs: number) {
    this.deadlineMs = Date.now() + timeoutMs;
  }

  configure(poolSize: number): number {
    this.poolSize = poolSize;
    this.maxNormalSends = poolSize <= 1 ? 3 : Math.min(12, Math.max(4, poolSize * 2));
    return this.maxNormalSends;
  }

  recordFailure(error: unknown): void {
    this.lastError = error;
  }

  graceDelay(error: unknown): number | null {
    const hint = this.transientHint(error);
    if (hint === undefined || (this.poolSize > 1 && this.round === 0)) {
      return null;
    }
    const limit = this.poolSize <= 1 ? 30_000 : 5000;
    if (hint !== null) {
      return hint <= limit ? hint : null;
    }
    return this.poolSize <= 1 ? Math.min(3000 * this.normalSends, 10_000) : null;
  }

  private transientHint(error: unknown): number | null | undefined {
    if (!(error instanceof UpstreamRequestError) || error.status !== 429) {
      return undefined;
    }
    if (hasExplicitQuotaExhaustedSignal([error.body, error.message].join('\n'))) {
      return undefined;
    }
    const hint =
      parseRetryDelay(error.body, error.headers?.retryAfter) ?? parseRetryDelay(error.message);
    if (!hint) {
      return null;
    }
    return (
      hint.delayMs +
      (hint.source === 'text' ? TEXT_GRACE_RETRY_BUFFER_MS : STRUCTURED_GRACE_RETRY_BUFFER_MS)
    );
  }

  private normalDelay(rotation: OrdinaryAccountRotation): number {
    if (this.normalSends === 0) {
      return 0;
    }
    const hint = this.transientHint(this.lastError);
    if (this.poolSize <= 1 && hint !== undefined) {
      return hint === null ? Math.min(3000 * this.normalSends, 10_000) : Math.min(hint, 30_000);
    }
    if (this.poolSize > 1 && this.round > 0 && hint !== undefined) {
      if (hint === null) {
        return Math.min(2000 * Math.max(1, this.normalSends - this.poolSize), 5000);
      }
      if (hint > 5000 && this.poolSize > 2 && this.normalSends < this.poolSize * 2) {
        return 50;
      }
      return Math.min(hint, 12_000);
    }
    return rotation.getRotationDelayMs(this.normalSends);
  }

  async wait(delayMs: number, signal?: AbortSignal): Promise<boolean> {
    throwIfRequestAborted(signal);
    // Reject an unaffordable wait before registering a timer; the caller keeps its last error.
    if (Date.now() + delayMs >= this.deadlineMs) {
      return false;
    }
    if (delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          reject(new DOMException('Upstream request cancelled', 'AbortError'));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', abort);
          resolve();
        }, delayMs);
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
    throwIfRequestAborted(signal);
    return Date.now() < this.deadlineMs;
  }

  async select(
    lease: OrdinaryRetryLease,
    rotation: OrdinaryAccountRotation,
    model: string,
    sessionKey?: string,
    signal?: AbortSignal,
    effort?: string,
    physicalTarget = false,
  ): Promise<CloudAccount | null> {
    throwIfRequestAborted(signal);
    if (
      rotation.isExhausted() ||
      this.normalSends >= this.maxNormalSends ||
      Date.now() >= this.deadlineMs
    ) {
      return null;
    }
    let token = await lease.getNextToken({
      model,
      effort,
      physicalTarget,
      sessionKey,
      excludeAccountIds: Array.from(this.roundAccountIds),
      signal,
      selectionDeadlineMs: this.deadlineMs,
      ...(this.normalSends > 0 ? { allowSelectionWait: false } : {}),
    });
    throwIfRequestAborted(signal);
    let waited = false;
    if (!token && this.normalSends > 0) {
      const poolWait = lease.getOrdinaryRetryWaitMs({ model, effort, physicalTarget });
      if (poolWait === null) {
        return null;
      }
      const cap = this.poolSize <= 1 ? 30_000 : 12_000;
      if (
        !(await this.wait(Math.min(cap, Math.max(poolWait, this.normalDelay(rotation))), signal))
      ) {
        return null;
      }
      waited = true;
      // Clearing request exclusions never clears shared cooldowns or quota locks.
      this.round += 1;
      this.roundAccountIds.clear();
      token = await lease.getNextToken({
        model,
        effort,
        physicalTarget,
        sessionKey,
        excludeAccountIds: [],
        allowSelectionWait: false,
        signal,
        selectionDeadlineMs: this.deadlineMs,
      });
      throwIfRequestAborted(signal);
    }
    if (!token || (!waited && !(await this.wait(this.normalDelay(rotation), signal)))) {
      return null;
    }
    if (lease.getOrdinaryRetryWaitMs({ model, effort, physicalTarget, accountId: token.id }) !== 0) {
      return null;
    }
    throwIfRequestAborted(signal);
    if (Date.now() >= this.deadlineMs) {
      return null;
    }
    this.normalSends += 1;
    this.roundAccountIds.add(token.id);
    return token;
  }
}
