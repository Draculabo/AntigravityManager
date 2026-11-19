import type { Observable } from 'rxjs';
import type { FlowControlledSseStream } from '../../../common/flow-controlled-sse-stream';
import type { SerializedResponsesFrame } from './OpenAIResponsesStreamingMapper';

/** One producer-owned canonical frame, consumed synchronously during its Observable delivery. */
export class SerializedResponsesFrames {
  private current: SerializedResponsesFrame | undefined;

  capture = (frame: SerializedResponsesFrame): void => {
    this.current = frame;
  };

  take(sse: string): SerializedResponsesFrame | undefined {
    const frame = this.current;
    this.current = undefined;
    return frame?.sse === sse ? frame : undefined;
  }

  clear(): void {
    this.current = undefined;
  }
}

// Only the owning mapper producers register this capability. Observable wrappers do not
// inherit it: they may alter the bytes, so their output still crosses the JSON boundary.
const producers = new WeakMap<Observable<unknown>, SerializedResponsesFrames>();

export function registerSerializedResponsesFrames(
  stream: FlowControlledSseStream,
  frames: SerializedResponsesFrames,
): FlowControlledSseStream {
  producers.set(stream, frames);
  return stream;
}

export function takeSerializedResponsesFrame(
  stream: Observable<unknown>,
  chunk: unknown,
): SerializedResponsesFrame | undefined {
  return typeof chunk === 'string' ? producers.get(stream)?.take(chunk) : undefined;
}
