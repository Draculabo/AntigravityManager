import { AppError } from '@/shared/errors/appError';
import type {
  ProcessDiagnostic,
  ProcessOwnershipDiagnostic,
} from '@/shared/observability/processDiagnostic';

export type ProcessFailure = ProcessDiagnostic['reason'];

export class AntigravityProcessError extends AppError<'ANTIGRAVITY_PROCESS_FAILED'> {
  readonly processDiagnostic: ProcessDiagnostic;

  constructor(
    reason: ProcessFailure,
    cause?: unknown,
    windowsErrorCode?: number,
    ownership?: ProcessOwnershipDiagnostic,
  ) {
    super('ANTIGRAVITY_PROCESS_FAILED', `Antigravity process operation: ${reason}`, {
      messageKey: `process-runtime.${reason}`,
      metadata: {},
      reportToSentry: false,
      transportCode: reason === 'busy' ? 'BAD_REQUEST' : 'INTERNAL_SERVER_ERROR',
      cause,
    });
    this.processDiagnostic = {
      reason,
      ...(windowsErrorCode !== undefined ? { windowsErrorCode } : {}),
      ...(ownership ? { ownership } : {}),
    };
  }
}

export function processError(
  reason: ProcessFailure,
  cause?: unknown,
  windowsErrorCode?: number,
): AntigravityProcessError {
  return new AntigravityProcessError(reason, cause, windowsErrorCode);
}

/** Attach closed identity evidence without exposing the observed process records. */
export function processOwnershipError(
  reason: ProcessFailure,
  ownership: ProcessOwnershipDiagnostic,
  cause?: unknown,
): AntigravityProcessError {
  return new AntigravityProcessError(reason, cause, undefined, ownership);
}
