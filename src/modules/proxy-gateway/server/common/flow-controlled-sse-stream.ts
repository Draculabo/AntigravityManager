import { Observable, type Subscriber, type TeardownLogic, Subscription } from 'rxjs';

/** Carries the actual Readable's flow capability without changing the Observable wire contract. */
export class FlowControlledSseStream<T = string> extends Observable<T> {
  private blocked = false;

  public constructor(
    private readonly readable: { pause: () => void; resume: () => void; destroy?: () => void },
    subscribe: (subscriber: Subscriber<T>) => TeardownLogic,
  ) {
    super(subscribe);
  }

  public get isPaused(): boolean {
    return this.blocked;
  }

  public pause(): void {
    this.blocked = true;
    this.readable.pause();
  }

  public resume(): void {
    this.blocked = false;
    this.readable.resume();
  }

  /** Releases a late, unconsumed result after its request owner has disconnected. */
  public destroy(): void {
    this.readable.destroy?.();
  }
}

interface ReadableOwner {
  readonly destroyed?: boolean;
  pause(): void;
  resume(): void;
  destroy?(): void;
}

export interface SseFrameSink {
  write(frames: Iterable<string>): void;
  replace(frames: Iterable<string>): void;
  end(): void;
}

/** Holds iterators, never pre-serializes the next frame while the consumer is blocked. */
class PausableSseFrames implements SseFrameSink {
  private readonly pending: Iterator<string>[] = [];
  private draining = false;
  private ending = false;
  private stopped = false;

  constructor(
    private readonly subscriber: Subscriber<string>,
    private readonly upstream: ReadableOwner | undefined,
    private blocked: boolean,
  ) {}

  write(frames: Iterable<string>): void {
    if (this.stopped || this.subscriber.closed) {
      return;
    }
    this.pending.push(frames[Symbol.iterator]());
    this.upstream?.pause();
    this.drain();
  }

  replace(frames: Iterable<string>): void {
    this.clear();
    this.write(frames);
  }

  end(): void {
    this.ending = true;
    this.drain();
  }

  pause(): void {
    this.blocked = true;
    this.upstream?.pause();
  }

  resume(): void {
    this.blocked = false;
    this.drain();
  }

  close(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.clear();
    if (!this.upstream?.destroyed) {
      this.upstream?.destroy?.();
    }
  }

  private clear(): void {
    for (const iterator of this.pending.splice(0)) {
      iterator.return?.();
    }
  }

  private drain(): void {
    if (this.draining || this.stopped || this.subscriber.closed) {
      return;
    }
    this.draining = true;
    try {
      while (!this.blocked && !this.stopped && !this.subscriber.closed) {
        const iterator = this.pending[0];
        if (!iterator) {
          if (this.ending) {
            this.subscriber.complete();
          } else {
            this.upstream?.resume();
            // A synchronous source may enqueue a new iterator during resume.
            if (this.pending.length > 0) {
              continue;
            }
          }
          break;
        }
        const frame = iterator.next();
        if (frame.done) {
          this.pending.shift();
        } else {
          this.subscriber.next(frame.value);
        }
      }
    } catch (error) {
      this.subscriber.error(error);
    } finally {
      this.draining = false;
    }
  }
}

/** Single-consumer producer; a cooperative upstream is paused until its current iterator drains. */
export function createFrameControlledSseStream(
  upstream: ReadableOwner | undefined,
  setup: (sink: SseFrameSink) => TeardownLogic,
): FlowControlledSseStream {
  let frames: PausableSseFrames | undefined;
  const stream = new FlowControlledSseStream(
    {
      pause: () => (frames ? frames.pause() : upstream?.pause()),
      resume: () => (frames ? frames.resume() : upstream?.resume()),
      destroy: () => (frames ? frames.close() : upstream?.destroy?.()),
    },
    (subscriber) => {
      frames = new PausableSseFrames(subscriber, upstream, stream.isPaused);
      const teardown = new Subscription(() => frames?.close());
      upstream?.pause();
      try {
        teardown.add(setup(frames));
      } catch (error) {
        teardown.unsubscribe();
        throw error;
      }
      return teardown;
    },
  );
  return stream;
}

/** Produces frames only on demand; cancellation closes the generator. */
export function createLazySseStream(generate: () => Iterable<string>): FlowControlledSseStream {
  return createFrameControlledSseStream(undefined, (sink) => {
    queueMicrotask(() => {
      sink.write(
        (function* () {
          yield* generate();
        })(),
      );
      sink.end();
    });
  });
}
