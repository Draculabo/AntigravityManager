import { ORPCError } from '@orpc/server';
import {
  readDesktopOAuthLoginErrorCode,
  type DesktopOAuthLoginErrorCode,
} from './desktop-oauth-login.schema';

export class DesktopOAuthLoginError extends Error {
  constructor(readonly loginCode: DesktopOAuthLoginErrorCode) {
    super('Google account login failed');
    this.name = 'DesktopOAuthLoginError';
  }
}

export function oauthFailureCode(message: string): DesktopOAuthLoginErrorCode {
  switch (message) {
    case 'Google authorization was denied':
      return 'authorization-denied';
    case 'OAuth login timed out':
      return 'login-timeout';
    case 'OAuth login was cancelled':
      return 'login-cancelled';
    case 'Google account already exists':
      return 'duplicate-account';
    default:
      return 'login-failed';
  }
}

export function toDesktopOAuthLoginORPCError(error: unknown) {
  const loginCode =
    readDesktopOAuthLoginErrorCode(error) ??
    (error instanceof DesktopOAuthLoginError ? error.loginCode : 'login-failed');
  const status =
    loginCode === 'login-active'
      ? 'CONFLICT'
      : loginCode === 'login-failed'
        ? 'INTERNAL_SERVER_ERROR'
        : 'BAD_REQUEST';
  return new ORPCError(status, {
    message: 'Google account login failed',
    data: { loginCode },
  });
}
