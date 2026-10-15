import { ORPCError } from '@orpc/server';
import { z } from 'zod';
import {
  readCloudAccountSwitchErrorCode,
  parseCloudAccountSwitchORPCErrorData,
  type CloudAccountSwitchErrorCode,
} from './cloud-account-switch.schema';
import type { CloudSwitchDiagnostic } from './operation-diagnostic.schema';
import { CredentialReadbackError } from '@/shared/auth/credentialReadbackError';
import { isErrorWithCode } from '@/shared/errors/error-guards';

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
  if (error instanceof CredentialReadbackError) {
    return 'credential-readback-mismatch';
  }
  const result = DiagnosticErrorCodeSchema.safeParse(
    isErrorWithCode(error) ? error.code : undefined,
  );
  return result.success ? result.data : 'unknown';
}

export class CloudAccountSwitchError extends Error {
  constructor(
    readonly switchCode: CloudAccountSwitchErrorCode,
    readonly diagnostic?: CloudSwitchDiagnostic,
  ) {
    super('Cloud account switch failed');
    this.name = 'CloudAccountSwitchError';
  }
}

export function toCloudAccountSwitchORPCError(error: unknown) {
  const forwarded =
    error instanceof ORPCError ? parseCloudAccountSwitchORPCErrorData(error.data) : null;
  const diagnostic =
    forwarded?.diagnostic ??
    (error instanceof CloudAccountSwitchError ? error.diagnostic : undefined);
  const switchCode =
    readCloudAccountSwitchErrorCode(error) ??
    (error instanceof CloudAccountSwitchError ? error.switchCode : 'switch-failed');
  return new ORPCError(switchCode === 'switch-failed' ? 'INTERNAL_SERVER_ERROR' : 'BAD_REQUEST', {
    message: 'Cloud account switch failed',
    data: { switchCode, ...(diagnostic ? { diagnostic } : {}) },
  });
}
