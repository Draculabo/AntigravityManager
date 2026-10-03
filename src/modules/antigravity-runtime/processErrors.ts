import { AppError } from '@/shared/errors/appError';

export type ProcessFailure =
  | 'busy'
  | 'missing-executable'
  | 'target-conflict'
  | 'directory-conflict'
  | 'probe-failed'
  | 'launch-failed'
  | 'close-failed'
  | 'exit-unconfirmed'
  | 'startup-unconfirmed'
  | 'switched-hot-unconfirmed'
  | 'switched-startup-unconfirmed';

export function processError(reason: ProcessFailure): AppError<'ANTIGRAVITY_PROCESS_FAILED'> {
  return new AppError('ANTIGRAVITY_PROCESS_FAILED', `Antigravity process operation: ${reason}`, {
    messageKey: `process-runtime.${reason}`,
    metadata: {},
    reportToSentry: false,
    transportCode: reason === 'busy' ? 'BAD_REQUEST' : 'INTERNAL_SERVER_ERROR',
  });
}
