/** One initial-selection deadline survives hydration failover; it never releases shared locks. */
export class AccountLeaseSelectionWait {
  private readonly deadlineMs: number;

  constructor(
    maxWaitMs: number,
    private readonly signal?: AbortSignal,
    requestDeadlineMs = Infinity,
  ) {
    this.deadlineMs = Math.min(Date.now() + Math.max(0, maxWaitMs), requestDeadlineMs);
  }

  remainingMs(): number {
    return this.signal?.aborted ? 0 : Math.max(0, this.deadlineMs - Date.now());
  }

  async wait(ms: number): Promise<boolean> {
    if (
      this.signal?.aborted ||
      !Number.isFinite(ms) ||
      ms <= 0 ||
      Date.now() + ms > this.deadlineMs
    ) {
      return false;
    }
    const elapsed = await new Promise<boolean>((resolve) => {
      const finish = (completed: boolean) => {
        clearTimeout(timer);
        this.signal?.removeEventListener('abort', abort);
        resolve(completed);
      };
      const abort = () => finish(false);
      const timer = setTimeout(() => finish(true), ms);
      this.signal?.addEventListener('abort', abort, { once: true });
    });
    return elapsed && !this.signal?.aborted && Date.now() <= this.deadlineMs;
  }
}
