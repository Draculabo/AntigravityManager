import { calculateRetryDelay } from '../../../../modules/proxy-gateway/antigravity/retry-utils';
import { UpstreamRequestError } from '../../common/exceptions/upstream-request.exception';
import { hasExplicitQuotaExhaustedSignal, parseRetryDelay } from './rate-limit-tracker.service';

/** Distinct failed accounts, rather than a zero-based loop index, bound generic 429 rotation. */
export class OrdinaryAccountRotation {
  private readonly genericRateLimitedAccounts = new Set<string>();
  private selectedAccountId?: string;
  private ordinaryRequest = false;
  private failed = false;
  private lastFailureWas429 = false;

  selectAccount(accountId: string, ordinaryRequest: boolean): void {
    this.selectedAccountId = accountId;
    this.ordinaryRequest = ordinaryRequest;
  }

  recordFailure(error: unknown): void {
    if (!this.ordinaryRequest || !this.selectedAccountId) {
      return;
    }
    this.failed = true;
    this.lastFailureWas429 = error instanceof UpstreamRequestError && error.status === 429;
    if (!this.lastFailureWas429 || !(error instanceof UpstreamRequestError)) {
      return;
    }

    const text = [error.body, error.message].filter((value) => value !== undefined).join('\n');
    const hint =
      parseRetryDelay(error.body, error.headers?.retryAfter) ?? parseRetryDelay(error.message);
    if (!hasExplicitQuotaExhaustedSignal(text) && hint === null) {
      this.genericRateLimitedAccounts.add(this.selectedAccountId);
    }
  }

  isExhausted(): boolean {
    return this.genericRateLimitedAccounts.size >= 2;
  }

  getRotationDelayMs(attemptedAccounts: number): number {
    if (!this.failed || attemptedAccounts === 0) {
      return 0;
    }
    return this.lastFailureWas429 ? 50 : calculateRetryDelay(attemptedAccounts - 1);
  }
}
