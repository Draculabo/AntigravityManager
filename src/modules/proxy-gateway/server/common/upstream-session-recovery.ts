import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { UpstreamRequestError } from './exceptions/upstream-request.exception';
import type { UpstreamSessionIdentity } from './upstream-session-identity';

interface RecoveryRecord {
  accountId?: string;
  identity: UpstreamSessionIdentity;
  touchedAt: number;
}
interface RecoveryFrame {
  key: string;
  record: RecoveryRecord;
  identity: UpstreamSessionIdentity;
}
interface RecoveryAdmission {
  identity: UpstreamSessionIdentity;
  timeoutMs: number;
}
/** Owned by one logical protocol invocation, shared across its account/project fallbacks. */
export interface UpstreamSessionRecoveryBudget {
  attempted: boolean;
  deadlineAt?: number;
  thinkingOnlyAttempted?: boolean;
  thinkingOnlyEnabled?: boolean;
}
interface RecoveryExecution<T> {
  accountId?: string;
  budget?: UpstreamSessionRecoveryBudget;
  identity?: UpstreamSessionIdentity;
  canRecover?: () => boolean;
  signal?: AbortSignal;
  timeoutMs: number;
  initial(identity?: UpstreamSessionIdentity): Promise<T>;
  recover(admit: () => RecoveryAdmission): Promise<T>;
}

// Preserve the original error/status without attaching transport policy to its message.
const terminalRecoveryFailures = new WeakSet<Error>();

export function isUpstreamSessionRecoveryFailure(error: unknown): error is Error {
  return error instanceof Error && terminalRecoveryFailures.has(error);
}

export function isUpstreamInputLimitError(error: unknown): error is UpstreamRequestError {
  return (
    error instanceof UpstreamRequestError &&
    error.status === 400 &&
    /\binput token count exceeds the maximum number of tokens\b/i.test(error.message.slice(0, 4096))
  );
}

/** Client-owned recovery identities, never conversation bodies or persistent generation state. */
export class UpstreamSessionRecovery {
  private readonly records = new Map<string, RecoveryRecord>();
  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly clock: () => number;

  public constructor(options: { capacity?: number; ttlMs?: number; clock?: () => number } = {}) {
    this.capacity = options.capacity ?? 500;
    this.ttlMs = options.ttlMs ?? 60 * 60 * 1000;
    this.clock = options.clock ?? (() => performance.now());
  }

  public get size(): number {
    this.expire(this.clock());
    return this.records.size;
  }

  /** Synchronous invalidation also revokes the record references held by in-flight recovery. */
  public forgetAccount(accountId: string): void {
    for (const [key, record] of this.records) {
      if (record.accountId === accountId) {
        this.records.delete(key);
      }
    }
  }

  /** The recovery transport must call admit immediately before its one physical send. */
  public async execute<T>(execution: RecoveryExecution<T>): Promise<T> {
    const budget = execution.budget ?? { attempted: false };
    const deadline = budget.deadlineAt ?? (budget.deadlineAt = this.clock() + execution.timeoutMs);
    const frame =
      execution.identity && execution.canRecover?.()
        ? this.acquire(execution.identity, execution.accountId)
        : undefined;
    try {
      return await execution.initial(frame?.identity ?? execution.identity);
    } catch (original) {
      if (
        !isUpstreamInputLimitError(original) ||
        !frame ||
        !execution.canRecover ||
        budget.attempted
      ) {
        throw original;
      }
      let admitted = false;
      try {
        if (execution.signal?.aborted || !execution.canRecover() || this.clock() >= deadline) {
          throw original;
        }
        return await execution.recover(() => {
          const timeoutMs = Math.floor(deadline - this.clock());
          if (
            admitted ||
            budget.attempted ||
            execution.signal?.aborted ||
            timeoutMs <= 0 ||
            !execution.canRecover?.()
          ) {
            throw original;
          }
          const identity = this.advance(frame);
          if (!identity) {
            throw original;
          }
          admitted = true;
          budget.attempted = true;
          return { identity, timeoutMs };
        });
      } catch (error) {
        if (error instanceof Error) {
          terminalRecoveryFailures.add(error);
        }
        if (error instanceof Error && error !== original && error.cause === undefined) {
          error.cause = original;
        }
        throw error;
      }
    }
  }

  private acquire(identity: UpstreamSessionIdentity, accountId?: string): RecoveryFrame {
    const now = this.clock();
    this.expire(now);
    const key = JSON.stringify([accountId ?? null, identity.conversationId, identity.sessionId]);
    const record = this.records.get(key) ?? { accountId, identity, touchedAt: now };
    record.touchedAt = now;
    this.records.delete(key);
    this.records.set(key, record);
    while (this.records.size > this.capacity) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.records.delete(oldest);
    }
    return { key, record, identity: record.identity };
  }

  private advance(frame: RecoveryFrame): UpstreamSessionIdentity | null {
    const now = this.clock();
    this.expire(now);
    if (this.records.get(frame.key) !== frame.record) {
      return null;
    }
    if (frame.record.identity === frame.identity) {
      const seed = JSON.stringify(['upstream-recovery:v1', frame.key, randomUUID()]);
      frame.record.identity = {
        sessionId: createHash('sha256').update(seed).digest().readBigInt64BE().toString(),
        conversationId: frame.identity.conversationId,
      };
    }
    frame.record.touchedAt = now;
    this.records.delete(frame.key);
    this.records.set(frame.key, frame.record);
    return frame.record.identity;
  }

  private expire(now: number): void {
    for (const [key, record] of this.records) {
      if (now - record.touchedAt < this.ttlMs) {
        break;
      }
      this.records.delete(key);
    }
  }
}
