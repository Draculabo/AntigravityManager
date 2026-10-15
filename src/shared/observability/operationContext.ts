import { randomUUID } from 'node:crypto';
import { logger } from '@/shared/logging/logger';
import type { OperationDiagnostic, OperationFailure, OperationReport } from './operationDiagnostic';
import { reportOperationFailure } from './errorReporting';
import { runWithOperationScope } from './operationScope';

/** Invocation-local state; a terminal failure is finalized once, including disabled reporting. */
export class OperationContext {
  readonly diagnosticId: string;
  private readonly steps: OperationReport['steps'] = [];
  private stepsTruncated = false;
  private terminal: OperationDiagnostic | undefined;

  constructor(
    readonly operation: OperationFailure['operation'],
    diagnosticId: string = randomUUID(),
  ) {
    this.diagnosticId = diagnosticId;
  }

  observe(
    stage: OperationFailure['stage'],
    outcome: OperationReport['steps'][number]['outcome'],
  ): void {
    if (this.terminal) {
      return;
    }
    const truncated = this.steps.length === 12;
    if (truncated && this.stepsTruncated) {
      return;
    }
    logger.info('Operation step v1', {
      schemaVersion: 1,
      diagnosticId: this.diagnosticId,
      operation: this.operation,
      stage,
      outcome,
      ...(truncated ? { truncated: true } : {}),
    });
    if (truncated) {
      this.stepsTruncated = true;
      return;
    }
    this.steps.push({ stage, outcome });
  }

  run<T>(action: () => T | Promise<T>): Promise<T> {
    return runWithOperationScope(
      { diagnosticId: this.diagnosticId, operation: this.operation },
      action,
    );
  }

  finish(
    failure: Omit<OperationFailure, 'schemaVersion' | 'diagnosticId' | 'operation'>,
    expected = false,
    sourceLocations?: OperationReport['sourceLocations'],
  ): OperationDiagnostic {
    if (this.terminal) {
      return this.terminal;
    }
    this.observe(failure.stage, 'failed');
    const report: OperationReport = {
      failure: {
        schemaVersion: 1,
        diagnosticId: this.diagnosticId,
        operation: this.operation,
        ...failure,
      },
      steps: [...this.steps],
      stepsTruncated: this.stepsTruncated,
      ...(sourceLocations?.length ? { sourceLocations } : {}),
    };
    const reporting = expected
      ? { state: 'not-reported' as const, reason: 'expected-outcome' as const }
      : reportOperationFailure(report);
    this.terminal = { ...report.failure, reporting };
    logger.info('Operation diagnostic v1', this.terminal);
    return this.terminal;
  }
}
