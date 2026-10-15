import { ORPCError } from '@orpc/server';
import {
  readDesktopOAuthLoginErrorCode,
  parseDesktopOAuthLoginErrorData,
  type DesktopOAuthLoginErrorCode,
} from './desktop-oauth-login.schema';
import type { GoogleLoginDiagnostic } from './operation-diagnostic.schema';

export class DesktopOAuthLoginError extends Error {
  constructor(
    readonly loginCode: DesktopOAuthLoginErrorCode,
    readonly diagnostic?: GoogleLoginDiagnostic,
  ) {
    super('Google account login failed');
    this.name = 'DesktopOAuthLoginError';
  }
}

export function toDesktopOAuthLoginORPCError(error: unknown) {
  const forwarded = error instanceof ORPCError ? parseDesktopOAuthLoginErrorData(error.data) : null;
  const loginCode =
    readDesktopOAuthLoginErrorCode(error) ??
    (error instanceof DesktopOAuthLoginError ? error.loginCode : 'login-failed');
  const diagnostic =
    forwarded?.diagnostic ??
    (error instanceof DesktopOAuthLoginError ? error.diagnostic : undefined);
  const status =
    loginCode === 'login-active'
      ? 'CONFLICT'
      : loginCode === 'login-failed'
        ? 'INTERNAL_SERVER_ERROR'
        : 'BAD_REQUEST';
  return new ORPCError(status, {
    message: 'Google account login failed',
    data: {
      loginCode,
      ...(diagnostic ? { diagnostic } : {}),
    },
  });
}
