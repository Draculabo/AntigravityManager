import { IncrementalSseLines } from './incremental-sse-lines';

const DECODE_WINDOW_BYTES = 64 * 1024;

type InputStep =
  | { kind: 'line'; line: string; decodedBytes: number }
  | { kind: 'window' | 'done'; decodedBytes: number };

/** One paused source chunk, one decoded window and the incremental unfinished line. */
export class AggregationInput {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private readonly lines = new IncrementalSseLines();
  private chunk: Buffer | undefined;
  private offset = 0;
  private text: string | undefined;
  private iterator: Generator<string> | undefined;
  private consumedUnits = 0;
  private previousLineUnits = 0;

  get active(): boolean {
    return this.chunk !== undefined;
  }

  get hasWork(): boolean {
    return (
      this.iterator !== undefined || (this.chunk !== undefined && this.offset < this.chunk.length)
    );
  }

  get unfinishedLineBytes(): number {
    return this.lines.estimatedRetainedBytes;
  }

  get transientBytes(): number {
    return (
      (this.chunk?.byteLength ?? 0) + (this.text === undefined ? 0 : this.text.length * 2 + 32)
    );
  }

  accept(chunk: Buffer): void {
    this.chunk = chunk;
    this.offset = 0;
  }

  next(): InputStep {
    let decodedBytes = 0;
    if (!this.iterator) {
      if (!this.chunk || this.offset >= this.chunk.length) {
        this.chunk = undefined;
        return { kind: 'done', decodedBytes };
      }
      const end = Math.min(this.offset + DECODE_WINDOW_BYTES, this.chunk.length);
      const window = this.chunk.subarray(this.offset, end);
      decodedBytes = window.byteLength;
      this.text = this.decoder.decode(window, { stream: true });
      this.offset = end;
      this.consumedUnits = 0;
      this.iterator = this.lines.push(this.text);
    }
    const next = this.iterator.next();
    if (next.done) {
      this.previousLineUnits += (this.text?.length ?? 0) - this.consumedUnits;
      this.clearWindow();
      return { kind: 'window', decodedBytes };
    }
    // A joined line can include earlier windows; only its suffix belongs to this window.
    this.consumedUnits += next.value.length + 1 - this.previousLineUnits;
    this.previousLineUnits = 0;
    if (this.consumedUnits === this.text?.length) {
      this.clearWindow();
    }
    return { kind: 'line', line: next.value, decodedBytes };
  }

  private clearWindow(): void {
    this.iterator?.return(undefined);
    this.iterator = undefined;
    this.text = undefined;
    this.consumedUnits = 0;
  }

  finish(): Generator<string> {
    return this.lines.push(this.decoder.decode() + '\n');
  }

  clear(): void {
    this.clearWindow();
    this.chunk = undefined;
    this.offset = 0;
    this.previousLineUnits = 0;
    this.lines.clear();
  }
}
