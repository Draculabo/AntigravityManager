import { WebSocket } from 'ws';
import { FlowControlledSseStream } from '../../../common/flow-controlled-sse-stream';
import { StreamOutputBudget } from '../../../common/stream-output-budget';
import type { OpenAIResponsesWebSocketEvent } from './openai-responses-websocket.protocol';

interface Frame {
  payload: Buffer;
  retainedBytes: number;
}

/** One complete JSON message per send; the callback releases ownership and admits the next frame. */
export class ResponsesWebSocketOutput {
  private readonly frames: Frame[] = [];
  private readonly budget: StreamOutputBudget;
  private sending = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private finish: (() => void) | null = null;

  constructor(
    private readonly socket: WebSocket,
    private readonly flow: FlowControlledSseStream<unknown> | null,
    private readonly fail: (error: Error) => void,
  ) {
    this.budget = new StreamOutputBudget((flow ? 128 : 16) * 1024 * 1024);
  }

  enqueue(event: OpenAIResponsesWebSocketEvent): void {
    if (this.stopped) {
      return;
    }
    this.enqueueSerialized(JSON.stringify(event));
  }

  /** Accepts canonical JSON only from the owning mapper or the validated fallback encoder. */
  enqueueSerialized(text: string): void {
    if (this.stopped) {
      return;
    }
    // Keep the existing conservative estimate: a paused producer can still own its
    // UTF-16 SSE frame while ws and this queue share the encoded payload.
    const retainedBytes = text.length * 2 + Buffer.byteLength(text) + 64;
    if (!this.budget.reserve(retainedBytes)) {
      this.abort('Responses WebSocket output budget exceeded');
      return;
    }
    try {
      this.frames.push({ payload: Buffer.from(text, 'utf8'), retainedBytes });
    } catch {
      this.budget.release(retainedBytes);
      this.abort('Responses WebSocket encoding failed');
      return;
    }
    this.pump();
  }

  end(finish: () => void): void {
    this.finish = finish;
    this.pump();
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.frames.length = 0;
    this.finish = null;
    this.budget.clear();
  }

  private pump(): void {
    if (this.stopped || this.sending) {
      return;
    }
    const frame = this.frames[0];
    if (!frame) {
      if (this.finish) {
        const finish = this.finish;
        this.stop();
        finish();
      } else {
        this.flow?.resume();
      }
      return;
    }
    if (this.socket.readyState !== WebSocket.OPEN) {
      this.abort('Responses WebSocket closed during output');
      return;
    }
    this.sending = true;
    this.flow?.pause();
    this.timer = setTimeout(() => this.abort('Responses WebSocket send timed out'), 30_000);
    this.timer.unref();
    try {
      this.socket.send(frame.payload, { binary: false }, (error) => {
        if (this.stopped) {
          return;
        }
        if (error) {
          this.abort('Responses WebSocket send failed');
          return;
        }
        if (this.timer) {
          clearTimeout(this.timer);
          this.timer = null;
        }
        this.frames.shift();
        this.budget.release(frame.retainedBytes);
        this.sending = false;
        this.pump();
      });
    } catch {
      this.abort('Responses WebSocket send failed');
    }
  }

  private abort(message: string): void {
    this.stop();
    this.fail(new Error(message));
  }
}
