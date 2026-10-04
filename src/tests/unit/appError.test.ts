import { ORPCError } from '@orpc/server';
import { describe, expect, it } from 'vitest';
import { AppError, getAppErrorData, shouldReportErrorToSentry } from '@/shared/errors/appError';
import { toPublicORPCError } from '@/ipc/router';
import { processError } from '@/modules/antigravity-runtime/processErrors';

describe('AppError', () => {
  it('preserves process failure meaning across IPC without command arguments or credential data', () => {
    const error = toPublicORPCError(processError('busy'), '["proc","startAntigravity"]');
    expect(error.code).toBe('BAD_REQUEST');
    expect(getAppErrorData(error)).toEqual({
      appErrorCode: 'ANTIGRAVITY_PROCESS_FAILED',
      messageKey: 'process-runtime.busy',
      reportToSentry: false,
      metadata: {},
    });
  });
  it('types metadata from the app error code', () => {
    const error = new AppError('CLOUD_ACCOUNT_LOGIN_EXPIRED', 'Cloud account login expired', {
      messageKey: 'error.cloudAccountLoginExpired',
      metadata: { accountId: 'account-1', email: 'user@example.com' },
    });

    const email: string | undefined = error.metadata?.email;

    expect(email).toBe('user@example.com');

    new AppError('CLOUD_ACCOUNT_LOGIN_EXPIRED', 'Cloud account login expired', {
      messageKey: 'error.cloudAccountLoginExpired',
      // @ts-expect-error CLOUD_ACCOUNT_LOGIN_EXPIRED metadata requires a string email.
      metadata: { accountId: 'account-1', email: 42 },
    });
  });

  it('exposes stable machine-readable data for UI and reporting decisions', () => {
    const cause = new Error('invalid_grant');
    const error = new AppError('CLOUD_ACCOUNT_LOGIN_EXPIRED', 'Cloud account login expired', {
      messageKey: 'error.cloudAccountLoginExpired',
      reportToSentry: false,
      transportCode: 'UNAUTHORIZED',
      metadata: { accountId: 'account-1', email: 'user@example.com' },
      cause,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.cause).toBe(cause);
    expect(getAppErrorData(error)).toEqual({
      appErrorCode: 'CLOUD_ACCOUNT_LOGIN_EXPIRED',
      messageKey: 'error.cloudAccountLoginExpired',
      reportToSentry: false,
      metadata: { accountId: 'account-1', email: 'user@example.com' },
    });
    expect(shouldReportErrorToSentry(error)).toBe(false);
  });

  it('converts AppError to ORPC data without relying on localized backend text', () => {
    const error = new AppError('CLOUD_ACCOUNT_LOGIN_EXPIRED', 'Cloud account login expired', {
      messageKey: 'error.cloudAccountLoginExpired',
      reportToSentry: false,
      transportCode: 'UNAUTHORIZED',
      metadata: { accountId: 'account-1', email: 'user@example.com' },
    });

    const publicError = toPublicORPCError(error, '["cloud","refreshAccountQuota"]');

    expect(publicError).toBeInstanceOf(ORPCError);
    expect(publicError.code).toBe('UNAUTHORIZED');
    expect(publicError.message).toBe('Cloud account login expired');
    expect(publicError.data).toMatchObject({
      appErrorCode: 'CLOUD_ACCOUNT_LOGIN_EXPIRED',
      messageKey: 'error.cloudAccountLoginExpired',
      reportToSentry: false,
      metadata: { accountId: 'account-1', email: 'user@example.com' },
      requestPath: '["cloud","refreshAccountQuota"]',
    });
  });

  it('preserves master-key recovery metadata across the public ORPC boundary', () => {
    const error = new AppError('MASTER_KEY_UNAVAILABLE', 'Stored account key is unavailable', {
      messageKey: 'error.masterKeyUnavailable',
      reportToSentry: false,
      metadata: {
        hint: 'HINT_MANUAL_SIGN',
        reason: 'PROVIDER_UNAVAILABLE',
        storedAccountCount: 12,
      },
    });

    const publicError = toPublicORPCError(error, '["cloud","getAccounts"]');

    expect(getAppErrorData(publicError)).toEqual({
      appErrorCode: 'MASTER_KEY_UNAVAILABLE',
      messageKey: 'error.masterKeyUnavailable',
      reportToSentry: false,
      metadata: {
        hint: 'HINT_MANUAL_SIGN',
        reason: 'PROVIDER_UNAVAILABLE',
        storedAccountCount: 12,
      },
    });
  });

  it('keeps only schema-approved local-import error data at the public IPC boundary', () => {
    const error = new ORPCError('BAD_REQUEST', {
      data: {
        localAccountImportErrorCode: 'session-expired',
        untrustedData: 'must-not-reach-renderer',
      },
      message: 'The local account import session has expired.',
    });

    const publicError = toPublicORPCError(error, '["cloud","localImport","confirm"]');

    expect(publicError.data).toMatchObject({
      localAccountImportErrorCode: 'session-expired',
      requestPath: '["cloud","localImport","confirm"]',
    });
    expect(publicError.data).not.toHaveProperty('untrustedData');
  });

  it('uses plain language for invalid settings without exposing internal details', () => {
    const error = new ORPCError('BAD_REQUEST', {
      message: 'Internal configuration owner error',
      data: { configCode: 'invalid-input' },
    });
    const publicError = toPublicORPCError(error, '["config","service","update"]');

    expect(publicError.code).toBe('BAD_REQUEST');
    expect(publicError.message).toBe(
      'Unable to complete that action. Check the details and try again.',
    );
    expect(publicError.data).toMatchObject({ configCode: 'invalid-input' });
    expect(publicError.message).not.toContain('owner');
  });
});
