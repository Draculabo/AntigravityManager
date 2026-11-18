const MAX_RETAINED_LINE_BYTES = 128 * 1024 * 1024;

/** Scans each decoded fragment once; joins an unfinished line only at its newline. */
export class IncrementalSseLines {
  private readonly fragments: string[] = [];
  private retainedBytes = 0;

  constructor(private readonly limit = MAX_RETAINED_LINE_BYTES) {}

  get estimatedRetainedBytes(): number {
    return this.retainedBytes;
  }

  *push(text: string): Generator<string> {
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf('\n', offset);
      const end = newline < 0 ? text.length : newline;
      const fragment = text.slice(offset, end);
      if (fragment) {
        const retained = fragment.length * 2 + 64;
        if (this.retainedBytes + retained > this.limit) {
          this.clear();
          throw new Error('Upstream SSE line exceeds decode budget.');
        }
        this.fragments.push(fragment);
        this.retainedBytes += retained;
      }
      if (newline < 0) {
        return;
      }
      const line = this.fragments.join('');
      this.clear();
      yield line;
      offset = newline + 1;
    }
  }

  clear(): void {
    this.fragments.length = 0;
    this.retainedBytes = 0;
  }
}
