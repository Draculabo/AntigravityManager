export interface LocalErrorCapture {
  message: string;
  error: Error | undefined;
}

export type LocalErrorSink = (capture: LocalErrorCapture) => void;

/** One process-owned sink. Registration does not enable reporting or perform file I/O. */
export class LocalErrorDispatch {
  private sink: LocalErrorSink | null = null;
  private dispatching = false;
  private failures = 0;

  register(sink: LocalErrorSink): () => void {
    this.sink = sink;
    return () => {
      if (this.sink === sink) {
        this.sink = null;
      }
    };
  }

  get failedCaptures(): number {
    return this.failures;
  }

  capture(capture: LocalErrorCapture): void {
    if (!this.sink) {
      return;
    }
    if (this.dispatching) {
      this.failures = Math.min(Number.MAX_SAFE_INTEGER, this.failures + 1);
      return;
    }
    this.dispatching = true;
    try {
      this.sink(capture);
    } catch {
      // The original error and existing reporting still belong to their callers.
      this.failures = Math.min(Number.MAX_SAFE_INTEGER, this.failures + 1);
    } finally {
      this.dispatching = false;
    }
  }
}
