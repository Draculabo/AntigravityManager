import { StreamOutputBudget, getStreamOutputRetainedBytes } from './stream-output-budget';
const MAX_STREAM_RETAINED_BYTES = 128 * 1024 * 1024;
const SLICE_CHARACTERS = 16 * 1024;
const DRAIN_TIMEOUT_MS = 30_000;

interface OutputFrame {
  text: string;
  offset: number;
  retainedBytes: number;
}

interface PumpCallbacks {
  write: (text: string) => boolean;
  pause: () => void;
  resume: () => void;
  finish: () => void;
  fail: (error: Error) => void;
}

/** Estimated retained UTF-16 strings, not process RSS or upstream mapper state. */
export function getSseOutputRetainedBytes(): number {
  return getStreamOutputRetainedBytes();
}

export class SseOutputPump {
  private readonly frames: OutputFrame[] = [];
  private readonly budget = new StreamOutputBudget(MAX_STREAM_RETAINED_BYTES);
  private blocked = false;
  private stopped = false;
  private ending = false;
  private timer: NodeJS.Timeout | null = null;

  public constructor(private readonly callbacks: PumpCallbacks) {}

  public enqueue(text: string): void {
    if (this.stopped) {
      return;
    }
    const retainedBytes = text.length * 2 + 64;
    if (!this.budget.reserve(retainedBytes)) {
      this.fail('SSE retained output budget exceeded');
      return;
    }
    this.frames.push({ text, offset: 0, retainedBytes });
    this.pump();
  }

  public end(): void {
    this.ending = true;
    this.pump();
  }

  public drain(): void {
    if (this.stopped) {
      return;
    }
    this.blocked = false;
    this.clearTimer();
    this.pump();
  }

  public stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.clearTimer();
    this.budget.clear();
    this.frames.length = 0;
  }

  private pump(): void {
    if (this.stopped || this.blocked) {
      return;
    }
    while (this.frames.length > 0) {
      const frame = this.frames[0];
      if (frame.offset === frame.text.length) {
        this.frames.shift();
        this.budget.release(frame.retainedBytes);
        continue;
      }
      let end = Math.min(frame.text.length, frame.offset + SLICE_CHARACTERS);
      const last = frame.text.charCodeAt(end - 1);
      if (end < frame.text.length && last >= 0xd800 && last <= 0xdbff) {
        end -= 1;
      }
      const slice = frame.text.slice(frame.offset, end);
      frame.offset = end;
      let ready: boolean;
      try {
        ready = this.callbacks.write(slice);
      } catch {
        this.fail('SSE socket write failed');
        return;
      }
      if (this.stopped) {
        return;
      }
      if (!ready) {
        this.blocked = true;
        this.callbacks.pause();
        this.timer = setTimeout(
          () => this.fail('SSE downstream drain timed out'),
          DRAIN_TIMEOUT_MS,
        );
        this.timer.unref();
        return;
      }
    }
    if (this.ending) {
      this.stop();
      this.callbacks.finish();
    } else {
      this.callbacks.resume();
    }
  }

  private fail(message: string): void {
    this.stop();
    this.callbacks.fail(new Error(message));
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
