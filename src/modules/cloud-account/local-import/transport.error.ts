import { ORPCError } from '@orpc/server';
import { LocalAccountImportCoordinatorError } from './local-account-import-coordinator.service';
import {
  parseLocalAccountImportORPCErrorData,
  type LocalAccountImportORPCErrorData,
} from './ipc/error-data';

export function toLocalAccountImportORPCError(
  error: unknown,
): ORPCError<string, LocalAccountImportORPCErrorData> {
  const remote =
    error instanceof ORPCError ? parseLocalAccountImportORPCErrorData(error.data) : null;
  if (remote && error instanceof ORPCError) {
    return new ORPCError(error.code, {
      message: 'The local account import request failed.',
      data: remote,
    });
  }
  if (!(error instanceof LocalAccountImportCoordinatorError)) {
    return new ORPCError('INTERNAL_SERVER_ERROR', {
      message: 'The local account import request failed.',
      data: {
        localAccountImportErrorCode: 'internal-error',
      },
    });
  }

  const transportCode =
    error.code === 'session-not-found' || error.code === 'background-task-not-found'
      ? 'NOT_FOUND'
      : error.code === 'session-expired' || error.code === 'session-consumed'
        ? 'BAD_REQUEST'
        : 'INTERNAL_SERVER_ERROR';
  return new ORPCError(transportCode, {
    message: error.message,
    data: {
      localAccountImportErrorCode: error.code,
    },
  });
}
