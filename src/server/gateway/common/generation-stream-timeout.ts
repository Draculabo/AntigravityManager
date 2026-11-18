import type { GenerationStreamPhase } from '../../../modules/proxy-gateway/antigravity/GenerationOutputState';

export interface GenerationStreamTimeouts {
  initialMs: number;
  activityMs: number;
  transitionMs: number;
}

/** A request owner bounds every phase; heartbeats never invoke observe. */
export class GenerationStreamTimeout {
  private phase: GenerationStreamPhase | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    private readonly timeouts: GenerationStreamTimeouts,
    private readonly remainingMs: () => number,
    private readonly expire: () => void,
  ) {}

  startAttempt(): void {
    if (this.closed) {
      return;
    }
    this.phase = undefined;
    this.observe('waiting_for_output');
  }

  observe(phase: GenerationStreamPhase): void {
    if (this.closed || (phase === 'waiting_for_output' && this.phase !== undefined)) {
      return;
    }
    this.phase = phase;
    this.arm(
      phase === 'waiting_for_output' ? this.timeouts.initialMs : this.timeouts.activityMs,
      false,
    );
  }

  dispose(): void {
    this.closed = true;
    clearTimeout(this.timer);
  }

  private arm(timeout: number, transition: boolean): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        if (this.closed) {
          return;
        }
        if (this.remainingMs() <= 0 || this.phase === 'waiting_for_output' || transition) {
          this.expire();
          return;
        }
        this.arm(this.timeouts.transitionMs, true);
      },
      Math.max(0, Math.min(timeout, this.remainingMs())),
    );
    this.timer.unref?.();
  }
}
