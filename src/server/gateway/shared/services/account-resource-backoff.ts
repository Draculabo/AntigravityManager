const COOLDOWN_SECONDS = [5, 15, 30] as const;
const FAILURE_EXPIRY_MS = 60 * 60 * 1000;

interface ResourceFailure {
  step: number;
  lastFailureMs: number;
}

/** Account-wide escalation is separate from model-scoped quota/capacity histories and locks. */
export class AccountResourceBackoff {
  private readonly failures = new Map<string, ResourceFailure>();

  nextDelaySeconds(accountId: string, now: number): number {
    const previous = this.failures.get(accountId);
    const step =
      previous && now - previous.lastFailureMs < FAILURE_EXPIRY_MS
        ? Math.min(previous.step + 1, COOLDOWN_SECONDS.length - 1)
        : 0;
    this.failures.set(accountId, { step, lastFailureMs: now });
    return COOLDOWN_SECONDS[step];
  }

  markSuccess(accountId: string): void {
    this.failures.delete(accountId);
  }

  clear(): void {
    this.failures.clear();
  }

  cleanupExpired(now: number): void {
    for (const [accountId, failure] of this.failures) {
      if (now - failure.lastFailureMs >= FAILURE_EXPIRY_MS) {
        this.failures.delete(accountId);
      }
    }
  }
}
