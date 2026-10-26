interface RetainedBytes {
  waitingRequestBytes: number;
  activeRequestBytes: number;
  unfinishedLineBytes: number;
  partBytes: number;
  metadataBytes: number;
  transientBytes: number;
}

const CATEGORIES = [
  'waitingRequestBytes',
  'activeRequestBytes',
  'unfinishedLineBytes',
  'partBytes',
  'metadataBytes',
  'transientBytes',
] as const;

export interface AggregationByteSnapshot extends RetainedBytes {
  totalBytes: number;
  peakBytes: number;
}

function emptyBytes(): RetainedBytes {
  return {
    waitingRequestBytes: 0,
    activeRequestBytes: 0,
    unfinishedLineBytes: 0,
    partBytes: 0,
    metadataBytes: 0,
    transientBytes: 0,
  };
}

/** Numeric ownership only: no request, response, credential or diagnostic payload is retained. */
export class AggregationByteAccount {
  private readonly bytes = emptyBytes();
  private closed = false;

  constructor(private readonly update: (category: keyof RetainedBytes, delta: number) => void) {}

  set(category: keyof RetainedBytes, bytes: number): void {
    if (this.closed) {
      return;
    }
    const delta = bytes - this.bytes[category];
    this.bytes[category] = bytes;
    this.update(category, delta);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const category of CATEGORIES) {
      this.update(category, -this.bytes[category]);
      this.bytes[category] = 0;
    }
  }
}

/** Phase aliases can overlap; totals deliberately overestimate instead of claiming exact RSS. */
export class AggregationByteAccounting {
  private readonly bytes = emptyBytes();
  private totalBytes = 0;
  private peakBytes = 0;

  get snapshot(): AggregationByteSnapshot {
    return { ...this.bytes, totalBytes: this.totalBytes, peakBytes: this.peakBytes };
  }

  open(): AggregationByteAccount {
    return new AggregationByteAccount((category, delta) => {
      this.bytes[category] += delta;
      this.totalBytes += delta;
      this.peakBytes = Math.max(this.peakBytes, this.totalBytes);
    });
  }
}

export const aggregationByteAccounting = new AggregationByteAccounting();
