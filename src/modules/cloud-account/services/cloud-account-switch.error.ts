import { ORPCError } from '@orpc/server';
import { z } from 'zod';
import {
  readCloudAccountSwitchErrorCode,
  type CloudAccountSwitchErrorCode,
} from './cloud-account-switch.schema';

const DiagnosticErrorCodeSchema = z.enum([
  'EACCES',
  'EPERM',
  'ENOENT',
  'EIO',
  'ENOSPC',
  'ETIMEDOUT',
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_READONLY',
  'SQLITE_CORRUPT',
  'SQLITE_CANTOPEN',
  'permission-denied',
  'locked',
  'malformed',
  'timed-out',
  'unavailable',
  'ANTIGRAVITY_PROCESS_FAILED',
  'KEYCHAIN_UNAVAILABLE',
  'MASTER_KEY_UNAVAILABLE',
]);

/** Keep native failure categories while excluding arbitrary provider text and error causes. */
export function readCloudAccountSwitchDiagnosticCode(
  error: unknown,
): z.infer<typeof DiagnosticErrorCodeSchema> | 'credential-readback-mismatch' | 'unknown' {
  if (!(error instanceof Error)) {
    return 'unknown';
  }
  if (error.message === 'Client credential-store write could not be confirmed') {
    return 'credential-readback-mismatch';
  }
  const result = DiagnosticErrorCodeSchema.safeParse('code' in error ? error.code : undefined);
  return result.success ? result.data : 'unknown';
}

export class CloudAccountSwitchError extends Error {
  constructor(readonly switchCode: CloudAccountSwitchErrorCode) {
    super('Cloud account switch failed');
    this.name = 'CloudAccountSwitchError';
  }
}

export function toCloudAccountSwitchORPCError(error: unknown) {
  const switchCode =
    readCloudAccountSwitchErrorCode(error) ??
    (error instanceof CloudAccountSwitchError ? error.switchCode : 'switch-failed');
  return new ORPCError(switchCode === 'switch-failed' ? 'INTERNAL_SERVER_ERROR' : 'BAD_REQUEST', {
    message: 'Cloud account switch failed',
    data: { switchCode },
  });
}
