import { randomUUID } from 'node:crypto';
import { CredentialReadbackError } from '@/shared/auth/credentialReadbackError';
import { logger } from '@/shared/logging/logger';
import { currentOperationIdentity } from '@/shared/observability/operationScope';
import {
  SwitchErrorSchema,
  SwitchSourceSchema,
  SWITCH_STAGE_OWNERS,
  type SwitchStage,
  type SwitchStep,
  type SwitchTrace,
} from '@/shared/observability/switchDiagnostic';
import { AntigravityProcessError } from '../processErrors';

/** Project closed evidence only; native prose, command lines and credentials never enter the trace. */
function evidence(error: unknown): Pick<SwitchStep, 'errors' | 'sources' | 'detailsTruncated'> {
  const errors: NonNullable<SwitchStep['errors']> = [];
  const sources: NonNullable<SwitchStep['sources']> = [];
  const seen = new Set<unknown>();
  let truncated = false;
  function visit(value: unknown): void {
    if (value === undefined) {
      return;
    }
    if (seen.has(value) || errors.length === 8) {
      truncated = true;
      return;
    }
    seen.add(value);
    const code = SwitchErrorSchema.shape.code
      .unwrap()
      .safeParse(value instanceof Error && 'code' in value ? value.code : undefined);
    errors.push(
      value instanceof AntigravityProcessError
        ? { kind: 'process', process: value.processDiagnostic }
        : value instanceof CredentialReadbackError
          ? { kind: 'credential-readback' }
          : code.success
            ? { kind: 'native', code: code.data }
            : { kind: 'unknown' },
    );
    if (value instanceof Error) {
      const stack = value.stack || '';
      if (stack.length > 16_384) {
        truncated = true;
      }
      for (const frame of stack
        .slice(0, 16_384)
        .matchAll(/(src[\\/]modules[\\/][A-Za-z0-9_./\\-]+\.ts):(\d+):(\d+)/g)) {
        const source = SwitchSourceSchema.safeParse({
          filename: frame[1].replaceAll('\\', '/'),
          lineno: Number(frame[2]),
          colno: Number(frame[3]),
        });
        if (
          source.success &&
          !sources.some((item) => JSON.stringify(item) === JSON.stringify(source.data))
        ) {
          if (sources.length < 8) {
            sources.push(source.data);
          } else {
            truncated = true;
          }
        }
      }
      visit(value.cause);
      if (value instanceof AggregateError) {
        for (const child of value.errors.slice(0, 8)) {
          visit(child);
        }
        if (value.errors.length > 8) {
          truncated = true;
        }
      }
    }
  }
  visit(error);
  return { errors, sources, ...(truncated ? { detailsTruncated: true } : {}) };
}

export class SwitchTraceRecorder {
  private readonly steps: SwitchStep[] = [];
  private readonly diagnosticId = currentOperationIdentity()?.diagnosticId || randomUUID();
  readonly effects: SwitchStep['effects'] = {
    credentials: 'not-attempted',
    services: 'untouched',
    client: 'original',
  };

  async phase<T>(
    stage: SwitchStage,
    mode: SwitchStep['mode'],
    action: () => Promise<T>,
    continuation: SwitchStep['continuation'] = 'stop',
  ): Promise<T> {
    const started = Date.now();
    const record = (outcome: SwitchStep['outcome'], error?: unknown) => {
      this.steps.push({
        stage,
        owner: SWITCH_STAGE_OWNERS[stage],
        mode,
        outcome,
        elapsedMs: Math.min(86_400_000, Math.max(0, Date.now() - started)),
        continuation: outcome === 'failed' ? continuation : 'continue',
        effects: { ...this.effects },
        ...(outcome === 'failed' ? evidence(error) : {}),
      });
    };
    record('started');
    try {
      const result = await action();
      record('succeeded');
      return result;
    } catch (error) {
      record('failed', error);
      throw error;
    }
  }

  finish(outcome: SwitchTrace['outcome']): SwitchTrace {
    const trace: SwitchTrace = {
      schemaVersion: 1,
      diagnosticId: this.diagnosticId,
      target: 'classic',
      outcome,
      steps: this.steps,
    };
    // One finite hot attempt and one restart have at most sixteen logical stages.
    // No arbitrary metadata or source exception is handed to the logger.
    try {
      logger.info('Switch trace v1', trace);
    } catch {
      /* Diagnostics do not undo a completed switch. */
    }
    return trace;
  }
}
