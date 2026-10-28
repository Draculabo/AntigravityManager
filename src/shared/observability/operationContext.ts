import { randomUUID } from 'node:crypto';
import { logger } from '@/shared/logging/logger';
import type { OperationDiagnostic, OperationFailure, OperationReport } from './operationDiagnostic';
import { reportOperationFailure } from './errorReporting';
import { runWithOperationScope } from './operationScope';
import type { SwitchTrace } from './switchDiagnostic';

/** Invocation-local state; a terminal failure is finalized once, including disabled reporting. */
export class OperationContext {
  readonly diagnosticId: string;
  private readonly steps: OperationReport['steps'] = [];
  private stepsTruncated = false;
  private terminal: OperationDiagnostic | undefined;
  private switchTrace: SwitchTrace | undefined;

  get lastStage(): OperationFailure['stage'] | undefined {
    return this.steps.at(-1)?.stage;
  }

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
    const truncated = this.steps.length === (this.operation === 'google-login' ? 12 : 64);
    if (truncated && this.stepsTruncated) {
      return;
    }
    try {
      logger.info('Operation step v1', {
        schemaVersion: 1,
        diagnosticId: this.diagnosticId,
        operation: this.operation,
        stage,
        outcome,
        ...(truncated ? { truncated: true } : {}),
      });
    } catch {
      /* Diagnostic logging does not own the business outcome. */
    }
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

  setSwitchTrace(trace: SwitchTrace): void {
    if (trace.diagnosticId === this.diagnosticId) {
      this.switchTrace = trace;
    }
  }

  /** A recovered hot attempt is one warning with a successful final outcome, not a switch error. */
  completeSwitch(): void {
    if (this.switchTrace?.outcome !== 'recovered-by-restart' || this.terminal) {
      return;
    }
    const failure = this.switchTrace.steps.find(
      (step) => step.mode === 'hot' && step.outcome === 'failed',
    );
    const process = failure?.errors?.find((error) => error.process)?.process;
    const nativeCode = failure?.errors?.find((error) => error.code)?.code;
    const readinessFailure =
      failure?.stage === 'service-replacement' || failure?.stage === 'terms-confirm';
    this.observe('account-finalize', 'succeeded');
    this.finish({
      stage:
        failure?.stage === 'service-stop'
          ? 'process-close'
          : readinessFailure
            ? 'process-start'
            : 'target-write',
      reason:
        failure?.stage === 'service-stop'
          ? 'process-close-failed'
          : readinessFailure
            ? 'process-start-failed'
            : nativeCode === 'EACCES' || nativeCode === 'EPERM'
              ? 'permission-denied'
              : 'unknown',
      ...(nativeCode ? { nativeCode } : {}),
      ...(process ? { process } : {}),
      target: 'classic',
    });
  }

  finish(
    failure: Omit<OperationFailure, 'schemaVersion' | 'diagnosticId' | 'operation'>,
    expected = false,
    sourceLocations?: OperationReport['sourceLocations'],
  ): OperationDiagnostic {
    if (this.terminal) {
      return this.terminal;
    }
    if (this.switchTrace?.outcome !== 'recovered-by-restart') {
      this.observe(failure.stage, 'failed');
    }
    const hotFailure = this.switchTrace?.steps.find(
      (step) => step.mode === 'hot' && step.outcome === 'failed',
    );
    const recoveryFailure = this.switchTrace?.steps.find(
      (step) => step.mode === 'restart' && step.outcome === 'failed',
    );
    const switchRecovery: OperationFailure['switchRecovery'] = hotFailure
      ? {
          outcome:
            this.switchTrace?.outcome === 'recovered-by-restart'
              ? 'recovered-by-restart'
              : 'failed',
          hotFailureStage: hotFailure.stage,
          ...(recoveryFailure ? { recoveryFailureStage: recoveryFailure.stage } : {}),
        }
      : undefined;
    const report: OperationReport = {
      failure: {
        schemaVersion: 1,
        diagnosticId: this.diagnosticId,
        operation: this.operation,
        ...failure,
        ...(switchRecovery ? { switchRecovery } : {}),
      },
      steps: [...this.steps],
      stepsTruncated: this.stepsTruncated,
      ...(sourceLocations?.length ? { sourceLocations } : {}),
      ...(this.switchTrace ? { switchTrace: this.switchTrace } : {}),
    };
    const reporting = expected
      ? { state: 'not-reported' as const, reason: 'expected-outcome' as const }
      : reportOperationFailure(report);
    this.terminal = { ...report.failure, reporting };
    try {
      logger.info('Operation diagnostic v1', this.terminal);
    } catch {
      /* The reporting receipt and business outcome remain authoritative. */
    }
    return this.terminal;
  }
}
