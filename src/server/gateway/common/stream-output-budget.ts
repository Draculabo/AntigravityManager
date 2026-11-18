const MAX_TOTAL_RETAINED_BYTES = 256 * 1024 * 1024;
let totalRetainedBytes = 0;

/** Shares conservative output reservations across HTTP SSE and Responses WebSockets. */
export class StreamOutputBudget {
  private retainedBytes = 0;
  constructor(private readonly limit: number) {}

  reserve(bytes: number): boolean {
    if (
      this.retainedBytes + bytes > this.limit ||
      totalRetainedBytes + bytes > MAX_TOTAL_RETAINED_BYTES
    ) {
      return false;
    }
    this.retainedBytes += bytes;
    totalRetainedBytes += bytes;
    return true;
  }

  release(bytes: number): void {
    this.retainedBytes -= bytes;
    totalRetainedBytes -= bytes;
  }

  clear(): void {
    this.release(this.retainedBytes);
  }
}

export function getStreamOutputRetainedBytes(): number {
  return totalRetainedBytes;
}
