import type { GeminiPart, GeminiContent } from '../antigravity/types';
import { decodeInternalGeminiPayload } from '../antigravity/internal-sse';
import { estimateRetainedJsonBytes } from '../../../server/gateway/common/retained-json-size';

const MAX_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_ALL_STREAM_BYTES = 256 * 1024 * 1024;
let retainedBytes = 0;

/** A failed or abandoned physical stream never publishes a complete recovery record. */
export class ThoughtStreamCapture {
  private parts: GeminiPart[] = [];
  private bytes = 0;
  private closed = false;
  private stopped = false;
  private output = false;

  constructor(
    private readonly active: () => boolean,
    private readonly commit: (content: GeminiContent) => void,
    private readonly refused: () => void,
  ) {}

  observe(value: unknown): void {
    if (this.closed) {
      return;
    }
    if (!this.active()) {
      this.finish(false);
      return;
    }
    const decoded = decodeInternalGeminiPayload(value);
    if (decoded.kind !== 'response' || (decoded.response.candidates?.length ?? 0) > 1) {
      this.finish(false);
      return;
    }
    const candidate = decoded.response.candidates?.[0];
    if (candidate?.finishReason) {
      this.stopped = candidate.finishReason.toUpperCase() === 'STOP';
    }
    for (const part of candidate?.content?.parts ?? []) {
      // Media is not a reasoning body. Retain business tool/text fields required by
      // exact per-part ownership without retaining another image/base64 copy.
      const kept: GeminiPart = {
        ...(part.text === undefined ? {} : { text: part.text }),
        ...(part.thought === undefined ? {} : { thought: part.thought }),
        ...(part.thoughtSignature === undefined ? {} : { thoughtSignature: part.thoughtSignature }),
        ...(part.thought_signature === undefined
          ? {}
          : { thought_signature: part.thought_signature }),
        ...(part.functionCall === undefined ? {} : { functionCall: part.functionCall }),
      };
      this.output ||= Boolean(
        part.functionCall || part.inlineData || (part.thought !== true && part.text?.trim()),
      );
      const bytes = estimateRetainedJsonBytes(kept);
      if (
        this.parts.length >= 2000 ||
        this.bytes + bytes > MAX_STREAM_BYTES ||
        retainedBytes + bytes > MAX_ALL_STREAM_BYTES
      ) {
        this.refused();
        this.finish(false);
        return;
      }
      this.parts.push(kept);
      this.bytes += bytes;
      retainedBytes += bytes;
    }
  }

  finish(complete: boolean): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const parts = this.parts;
    this.parts = [];
    retainedBytes -= this.bytes;
    this.bytes = 0;
    if (complete && this.stopped && this.output && this.active()) {
      this.commit({ role: 'model', parts });
    }
  }
}
