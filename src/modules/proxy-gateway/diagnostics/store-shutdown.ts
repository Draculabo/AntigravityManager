/** Distinguishes reusable gateway stop from terminal process-owned store shutdown. */
export class DiagnosticStoreShutdown {
  private stopping = false;
  private sealed = false;
  private shutdownPromise: Promise<void> | null = null;

  public acceptsWork(): boolean {
    return !this.stopping;
  }

  public requireAdmission(): void {
    if (this.stopping) {
      throw new Error('Diagnostic store is shutting down');
    }
  }

  public requireWorker(existing: boolean): void {
    if (this.sealed || (this.stopping && !existing)) {
      throw new Error('Diagnostic store is shutting down');
    }
  }

  public run(
    drain: () => Promise<unknown>,
    dispose: () => Promise<void>,
    timeoutMs = 2_000,
  ): Promise<void> {
    this.stopping = true;
    this.shutdownPromise ??= this.finish(drain, dispose, timeoutMs);
    return this.shutdownPromise;
  }

  private async finish(
    drain: () => Promise<unknown>,
    dispose: () => Promise<void>,
    timeoutMs: number,
  ): Promise<void> {
    const failures: unknown[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(drain),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Diagnostic store drain timed out')),
            timeoutMs,
          );
        }),
      ]);
    } catch (error) {
      failures.push(error);
    } finally {
      clearTimeout(timer);
      // Late continuations may settle, but cannot create or access a replacement worker.
      this.sealed = true;
    }
    try {
      await dispose();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Diagnostic store shutdown failed');
    }
  }
}
