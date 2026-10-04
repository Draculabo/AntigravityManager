import { ORPCError } from '@orpc/server';
import { ZodError } from 'zod';
import {
  readCloudIdentityProfileErrorCode,
  type CloudIdentityProfileErrorCode,
} from './cloud-account-identity-profile.schema';

export class CloudIdentityProfileError extends Error {
  constructor(readonly profileCode: CloudIdentityProfileErrorCode) {
    super('Cloud identity profile operation failed');
    this.name = 'CloudIdentityProfileError';
  }
}

export function classifyCloudIdentityProfileError(
  error: unknown,
  fallback: CloudIdentityProfileErrorCode,
): CloudIdentityProfileErrorCode {
  if (error instanceof CloudIdentityProfileError) {
    return error.profileCode;
  }
  if (error instanceof ZodError) {
    return 'profile-invalid';
  }
  if (error instanceof Error) {
    if (error.message.startsWith('Account not found:')) {
      return 'account-not-found';
    }
    if (error.message === 'Global original profile not found') {
      return 'baseline-unavailable';
    }
    if (
      error.message === 'Device profile version not found' ||
      error.message === 'Historical device profile not found' ||
      error.message === 'No currently bound profile'
    ) {
      return 'revision-not-found';
    }
    if (
      error.message === 'Original profile cannot be deleted' ||
      error.message === 'Currently bound profile cannot be deleted'
    ) {
      return 'profile-invalid';
    }
  }
  return fallback;
}

export function toCloudIdentityProfileORPCError(error: unknown) {
  const profileCode =
    readCloudIdentityProfileErrorCode(error) ??
    classifyCloudIdentityProfileError(error, 'profile-operation-failed');
  return new ORPCError(
    profileCode === 'profile-operation-failed' || profileCode === 'profile-write-failed'
      ? 'INTERNAL_SERVER_ERROR'
      : 'BAD_REQUEST',
    { message: 'Cloud identity profile operation failed', data: { profileCode } },
  );
}
