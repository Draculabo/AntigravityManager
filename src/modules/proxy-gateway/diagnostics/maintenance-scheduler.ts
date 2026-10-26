const INTERVAL_MS = 60 * 60 * 1_000;
const CONTINUATION_DELAY_MS = 1_000;

/** Coalesces bounded passes; successful backlog replies yield to the worker queue. */
export class DiagnosticMaintenanceScheduler {
  private interval: NodeJS.Timeout | null = null;
  private continuation: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private active = false;
  private generation = 0;

  public constructor(
    private readonly maintain: () => Promise<{ moreWorkPending: boolean }>,
    private readonly onFailure: (error: unknown) => void,
  ) {}

  public start(runImmediately = true): void {
    if (this.active) {
      return;
    }
    this.active = true;
    this.generation += 1;
    this.interval = setInterval(() => this.run(), INTERVAL_MS);
    this.interval.unref();
    if (runImmediately) {
      this.run();
    }
  }

  public stop(): void {
    this.active = false;
    this.generation += 1;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.continuation) {
      clearTimeout(this.continuation);
      this.continuation = null;
    }
  }

  public state(): 'running' | 'scheduled' | 'idle' | 'stopped' {
    if (this.running) {
      return 'running';
    }
    if (this.continuation) {
      return 'scheduled';
    }
    return this.active ? 'idle' : 'stopped';
  }

  public continueFrom(result: { moreWorkPending: boolean }): void {
    if (!this.active || !result.moreWorkPending || this.continuation) {
      return;
    }
    this.continuation = setTimeout(() => {
      this.continuation = null;
      this.run();
    }, CONTINUATION_DELAY_MS);
    this.continuation.unref();
  }

  private run(): void {
    if (!this.active || this.running) {
      return;
    }
    if (this.continuation) {
      clearTimeout(this.continuation);
      this.continuation = null;
    }
    const generation = this.generation;
    this.running = Promise.resolve()
      .then(async () => {
        if (!this.active || generation !== this.generation) {
          return;
        }
        const result = await this.maintain();
        if (this.active && generation === this.generation) {
          this.continueFrom(result);
        }
      })
      .catch(this.onFailure)
      .finally(() => {
        this.running = null;
        if (this.active && generation !== this.generation) {
          this.run();
        }
      });
  }
}
