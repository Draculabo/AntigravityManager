import { performance } from 'node:perf_hooks';
import { Readable } from 'node:stream';
import { Observable } from 'rxjs';
import { logger } from '@/shared/logging/logger';
import type { GenerationStreamPhase } from '../../../modules/proxy-gateway/antigravity/GenerationOutputState';
import { getTrafficAuditRequestContext } from '../../../modules/proxy-gateway/audit/traffic-audit-context';
import { FlowControlledSseStream } from './flow-controlled-sse-stream';
import { inheritObservableFlowControl } from './observable-flow-control';
import { awaitRequestOperation, throwIfRequestAborted } from './request-cancellation';
import { GenerationDeadlineExceededError } from './exceptions/generation-deadline.exception';
import { GenerationReplayLimitError } from './exceptions/generation-replay-limit.exception';
import { GENERATION_STREAM_TIMEOUTS } from './generation-timeout-policy';
import {
  GenerationStreamTimeout,
  type GenerationStreamTimeouts,
} from './generation-stream-timeout';

const scopes = new WeakMap<AbortSignal, GenerationDeadlineScope>();
export const LARGE_GENERATION_SEND_BYTES = 4 * 1024 * 1024;
const LARGE_GENERATION_SEND_LIMIT = 3;
const streamProgressOrder: Record<GenerationStreamPhase, number> = {
  waiting_for_output: 0,
  thinking_only: 1,
  output_started: 2,
};

/** One owner spans preparation, physical sends and the returned stream's complete lifetime. */
export class GenerationDeadlineScope {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  retained = false;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly cleanups = new Set<() => void>();
  private disposed = false;
  private streamPhase: GenerationStreamPhase | undefined;
  private streamTimeoutReported = false;
  private admittedSends = 0;
  private readonly streamTimeout?: GenerationStreamTimeout;

  constructor(
    timeoutMs: number,
    private readonly parent?: AbortSignal,
    streamTimeouts: GenerationStreamTimeouts = GENERATION_STREAM_TIMEOUTS,
  ) {
    this.signal = this.controller.signal;
    this.deadlineAt = performance.now() + timeoutMs;
    if (streamTimeouts) {
      this.streamTimeout = new GenerationStreamTimeout(
        streamTimeouts,
        () => this.deadlineAt - performance.now(),
        () => this.controller.abort(this.deadlineError()),
      );
    }
    scopes.set(this.signal, this);
    this.timer = setTimeout(() => this.controller.abort(this.deadlineError()), timeoutMs);
    this.timer.unref?.();
    parent?.addEventListener('abort', this.cancel, { once: true });
    if (parent?.aborted) {
      this.cancel();
    }
  }

  private readonly cancel = (): void => {
    this.controller.abort(this.parent?.reason);
  };

  startStreamAttempt(): void {
    this.streamPhase = 'waiting_for_output';
    this.streamTimeout?.startAttempt();
  }

  observeStreamProgress(phase: GenerationStreamPhase): void {
    if (!this.streamPhase || streamProgressOrder[phase] > streamProgressOrder[this.streamPhase]) {
      this.streamPhase = phase;
    }
    this.streamTimeout?.observe(this.streamPhase);
  }

  admitUpstreamSend(serializedBytes: number): void {
    if (
      serializedBytes >= LARGE_GENERATION_SEND_BYTES &&
      this.admittedSends >= LARGE_GENERATION_SEND_LIMIT
    ) {
      throw new GenerationReplayLimitError();
    }
    this.admittedSends += 1;
  }

  deadlineError(): GenerationDeadlineExceededError {
    if (this.streamPhase && !this.streamTimeoutReported) {
      this.streamTimeoutReported = true;
      logger.warn('Generation stream deadline exceeded', {
        phase: this.streamPhase,
        requestId: getTrafficAuditRequestContext()?.parent?.id ?? null,
      });
    }
    return new GenerationDeadlineExceededError();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    clearTimeout(this.timer);
    this.streamTimeout?.dispose();
    this.parent?.removeEventListener('abort', this.cancel);
    for (const cleanup of this.cleanups) {
      cleanup();
    }
    this.cleanups.clear();
  }

  retainReadable(stream: NodeJS.ReadableStream): NodeJS.ReadableStream {
    if (this.signal.aborted && stream instanceof Readable) {
      stream.destroy();
    }
    throwIfRequestAborted(this.signal);
    this.retained = true;
    const finish = () => this.dispose();
    const abort = () => {
      if (stream instanceof Readable) {
        stream.destroy(this.signal.reason instanceof Error ? this.signal.reason : undefined);
      } else {
        this.dispose();
      }
    };
    stream.once('end', finish);
    stream.once('close', finish);
    stream.once('error', finish);
    this.signal.addEventListener('abort', abort, { once: true });
    this.cleanups.add(() => {
      stream.removeListener('end', finish);
      stream.removeListener('close', finish);
      stream.removeListener('error', finish);
      this.signal.removeEventListener('abort', abort);
    });
    if (this.signal.aborted) {
      abort();
    }
    return stream;
  }

  retainObservable<T>(source: Observable<T>): Observable<T> {
    if (this.signal.aborted && source instanceof FlowControlledSseStream) {
      source.destroy();
    }
    throwIfRequestAborted(this.signal);
    this.retained = true;
    const disposeSource = () => {
      if (source instanceof FlowControlledSseStream) {
        source.destroy();
      }
    };
    const abortUnconsumed = () => {
      disposeSource();
      this.dispose();
    };
    this.signal.addEventListener('abort', abortUnconsumed, { once: true });
    this.cleanups.add(() => this.signal.removeEventListener('abort', abortUnconsumed));
    if (this.signal.aborted) {
      abortUnconsumed();
    }
    const subscribe = (subscriber: import('rxjs').Subscriber<T>) => {
      this.signal.removeEventListener('abort', abortUnconsumed);
      let finished = false;
      const abort = () => subscriber.error(this.signal.reason);
      this.signal.addEventListener('abort', abort, { once: true });
      if (this.signal.aborted) {
        abort();
      }
      const subscription = subscriber.closed
        ? undefined
        : source.subscribe({
            next: (value) => {
              if (!this.signal.aborted) {
                subscriber.next(value);
              }
            },
            error: (error: unknown) => {
              finished = true;
              subscriber.error(this.signal.aborted ? this.signal.reason : error);
            },
            complete: () => {
              finished = true;
              if (this.signal.aborted) {
                abort();
              } else {
                subscriber.complete();
              }
            },
          });
      return () => {
        this.signal.removeEventListener('abort', abort);
        subscription?.unsubscribe();
        disposeSource();
        if (!finished && !this.signal.aborted) {
          this.controller.abort(new DOMException('Upstream request cancelled', 'AbortError'));
        }
        this.dispose();
      };
    };
    const output =
      source instanceof FlowControlledSseStream
        ? new FlowControlledSseStream(source, subscribe)
        : new Observable(subscribe);
    return inheritObservableFlowControl(source, output);
  }
}

export function generationDeadlineAt(signal?: AbortSignal): number | undefined {
  return signal ? scopes.get(signal)?.deadlineAt : undefined;
}

/** A cancellation wrapper retains the same deadline, stream phase and physical-send admission. */
export function inheritGenerationDeadline(
  parent: AbortSignal | undefined,
  signal: AbortSignal,
): void {
  const scope = parent && scopes.get(parent);
  if (scope) {
    scopes.set(signal, scope);
  }
}

export function admitUpstreamGenerationSend(signal: AbortSignal, serializedBytes: number): void {
  scopes.get(signal)?.admitUpstreamSend(serializedBytes);
}

export function observeGenerationStreamProgress(
  signal: AbortSignal | undefined,
  phase: GenerationStreamPhase,
): void {
  if (signal && !signal.aborted) {
    scopes.get(signal)?.observeStreamProgress(phase);
  }
}

export function startGenerationStreamAttempt(signal?: AbortSignal): void {
  if (signal && !signal.aborted) {
    scopes.get(signal)?.startStreamAttempt();
  }
}

/** Recompute immediately before a physical send; timeout overrides cannot extend the owner. */
export function generationAttemptTimeout(
  signal: AbortSignal | undefined,
  configuredMs: number,
): number {
  throwIfRequestAborted(signal);
  const scope = signal && scopes.get(signal);
  if (!scope) {
    return configuredMs;
  }
  // The owner enforces the exact cutoff; rounding down can fire transport timeout first.
  const remaining = Math.ceil(scope.deadlineAt - performance.now());
  if (remaining <= 0) {
    throw scope.deadlineError();
  }
  return Math.min(configuredMs, remaining);
}

export async function runGenerationWithDeadline<T>(
  timeoutMs: number,
  parent: AbortSignal | undefined,
  execute: (signal: AbortSignal, owner: GenerationDeadlineScope | null) => Promise<T>,
): Promise<T> {
  throwIfRequestAborted(parent);
  if (parent && scopes.has(parent)) {
    return awaitGenerationOperation(execute(parent, null), parent);
  }
  const scope = new GenerationDeadlineScope(timeoutMs, parent);
  try {
    const result = await awaitGenerationOperation(execute(scope.signal, scope), scope.signal);
    generationAttemptTimeout(scope.signal, timeoutMs);
    return result;
  } finally {
    if (!scope.retained || scope.signal.aborted) {
      scope.dispose();
    }
  }
}

function awaitGenerationOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  void operation.then(
    (value) => {
      if (
        signal.aborted &&
        (value instanceof Readable || value instanceof FlowControlledSseStream)
      ) {
        value.destroy();
      }
    },
    () => undefined,
  );
  return awaitRequestOperation(operation, signal);
}
