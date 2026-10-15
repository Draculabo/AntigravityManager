import { OperationContext } from '@/shared/observability/operationContext';
import { classifyOperationCause } from './operation-cause';
import {
  GoogleLoginDiagnosticSchema,
  type GoogleLoginDiagnostic,
} from './operation-diagnostic.schema';
import type { CauseClassification } from '@/shared/observability/operationDiagnostic';
import { readFinalizedOperationDiagnostic } from '@/shared/observability/operationDiagnostic';

type LoginStage = GoogleLoginDiagnostic['stage'];
type AccountCommit = GoogleLoginDiagnostic['accountCommit'];

export class GoogleLoginStepError extends Error {
  constructor(
    readonly stage: LoginStage,
    readonly accountCommit: AccountCommit,
    readonly fallbackReason: CauseClassification['reason'],
    cause: unknown,
  ) {
    super('Google login step failed', { cause });
    this.name = 'GoogleLoginStepError';
  }
}

export class GoogleLoginOperation {
  readonly context: OperationContext;
  stage: LoginStage = 'client-selection';
  accountCommit: AccountCommit = 'not-attempted';

  constructor(diagnosticId?: string) {
    this.context = new OperationContext('google-login', diagnosticId);
  }

  enter(stage: LoginStage): void {
    this.stage = stage;
    this.context.observe(stage, 'started');
  }

  async run<T>(
    stage: LoginStage,
    action: () => T | Promise<T>,
    fallbackReason: CauseClassification['reason'] = 'unknown',
  ): Promise<T> {
    this.enter(stage);
    try {
      const result = await this.context.run(action);
      this.context.observe(stage, 'succeeded');
      return result;
    } catch (error) {
      if (readFinalizedOperationDiagnostic(error)) {
        throw error;
      }
      throw error instanceof GoogleLoginStepError
        ? error
        : new GoogleLoginStepError(stage, this.accountCommit, fallbackReason, error);
    }
  }

  finish(
    error: unknown,
    reason?: CauseClassification['reason'],
    expected = false,
  ): GoogleLoginDiagnostic {
    const classified = classifyOperationCause(error);
    const step = error instanceof GoogleLoginStepError ? error : null;
    return GoogleLoginDiagnosticSchema.parse(
      this.context.finish(
        {
          stage: step?.stage ?? this.stage,
          accountCommit: step?.accountCommit ?? this.accountCommit,
          ...classified.primary,
          reason:
            reason ??
            (classified.primary.reason === 'unknown'
              ? (step?.fallbackReason ?? 'unknown')
              : classified.primary.reason),
          causes: classified.causes,
          ...(classified.causesTruncated ? { causesTruncated: true } : {}),
        },
        expected,
        classified.sourceLocations,
      ),
    );
  }
}
