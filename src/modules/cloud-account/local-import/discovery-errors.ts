import type {
  LocalAccountDiscoveryFailure,
  LocalAccountDiscoveryFailureCode,
  LocalAccountSourceReference,
} from './types';

const ERROR_MESSAGES: Record<LocalAccountDiscoveryFailureCode, string> = {
  missing: 'The local credential source was not found.',
  'permission-denied': 'The local credential source denied access.',
  locked: 'The local credential source is locked or busy.',
  malformed: 'The local credential data is malformed.',
  'timed-out': 'Reading the local credential source timed out.',
  'read-failed': 'The local credential source could not be read.',
};

interface ErrorLike {
  code?: string;
  message?: string;
}

function getErrorLike(error: unknown): ErrorLike {
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    return {
      code,
      message: error.message,
    };
  }
  return {};
}

export function classifyLocalAccountDiscoveryError(
  error: unknown,
): LocalAccountDiscoveryFailureCode {
  const errorLike = getErrorLike(error);
  const code = errorLike.code?.toLowerCase() ?? '';
  const message = errorLike.message?.toLowerCase() ?? '';

  if (code === 'timed-out' || code === 'etimedout' || message.includes('timed out')) {
    return 'timed-out';
  }
  if (
    code === 'permission-denied' ||
    code === 'eacces' ||
    code === 'eperm' ||
    message.includes('permission denied') ||
    message.includes('access denied')
  ) {
    return 'permission-denied';
  }
  if (
    code === 'locked' ||
    code === 'sqlite_busy' ||
    code === 'sqlite_locked' ||
    message.includes('database is locked') ||
    message.includes('keyring is locked')
  ) {
    return 'locked';
  }
  if (
    code === 'missing' ||
    code === 'enoent' ||
    message.includes('not found') ||
    message.includes('no credential')
  ) {
    return 'missing';
  }
  if (
    code === 'malformed' ||
    error instanceof SyntaxError ||
    message.includes('malformed') ||
    message.includes('corrupt') ||
    message.includes('invalid json')
  ) {
    return 'malformed';
  }
  return 'read-failed';
}

export function createLocalAccountDiscoveryFailure(
  source: LocalAccountSourceReference,
  error: unknown,
): LocalAccountDiscoveryFailure {
  const code = classifyLocalAccountDiscoveryError(error);
  return {
    source,
    code,
    message: ERROR_MESSAGES[code],
  };
}

export function createLocalAccountDiscoveryFailureByCode(
  source: LocalAccountSourceReference,
  code: LocalAccountDiscoveryFailureCode,
): LocalAccountDiscoveryFailure {
  return {
    source,
    code,
    message: ERROR_MESSAGES[code],
  };
}
