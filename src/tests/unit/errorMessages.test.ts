import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import {
  getErrorDetailsText,
  getLocalizedErrorMessage,
  isDataMigrationError,
} from '@/shared/utils/errorMessages';

const CLOUD_ACCOUNT_LOGIN_EXPIRED_MESSAGE =
  'The login information for this cloud account has expired. Please log in again.';

function createT(): TFunction {
  return ((key: string, options?: { defaultValue?: string }) => {
    const messages: Record<string, string> = {
      'error.cloudAccountLoginExpired': CLOUD_ACCOUNT_LOGIN_EXPIRED_MESSAGE,
      'error.keychainUnavailable': "Can't access saved sign-in information right now.",
      'error.keychainHint.translocation':
        'Move the app to the Applications folder, then open it again.',
      'error.dataMigrationFailed': "Can't read accounts saved by an earlier version.",
      'error.dataMigrationHint.relogin': 'Please re-login or re-add your accounts.',
    };

    return messages[key] ?? options?.defaultValue ?? key;
  }) as unknown as TFunction;
}

describe('getLocalizedErrorMessage', () => {
  it('does not localize raw missing Antigravity storage.json switch failures', () => {
    const rawMessage = 'Switch failed: storage_json_not_found';
    const message = getLocalizedErrorMessage(new Error(rawMessage), createT());

    expect(message).toBe(rawMessage);
  });

  it('does not localize raw missing Antigravity storage.json from object-shaped errors', () => {
    const rawMessage = 'Switch failed: storage_json_not_found';
    const message = getLocalizedErrorMessage({ message: rawMessage }, createT());

    expect(message).toBe(rawMessage);
  });

  it('does not localize raw missing enterprise project_id switch failures', () => {
    const rawMessage =
      'Switch failed: Account user@example.com cannot be switched safely: enterprise OAuth requires a valid project_id.';
    const message = getLocalizedErrorMessage(new Error(rawMessage), createT());

    expect(message).toBe(rawMessage);
  });

  it('does not localize raw enterprise project_id auto-resolve failures', () => {
    const rawMessage =
      'Switch failed: Account user@example.com cannot be switched safely: missing enterprise project_id and auto-resolve failed (Forbidden).';
    const message = getLocalizedErrorMessage(
      {
        message: rawMessage,
      },
      createT(),
    );

    expect(message).toBe(rawMessage);
  });

  it('does not localize raw Antigravity database permission failures', () => {
    const rawMessage =
      "EACCES: permission denied, mkdir '/usr/bin/data/user-data/User/globalStorage'";
    const message = getLocalizedErrorMessage(new Error(rawMessage), createT());

    expect(message).toBe(rawMessage);
  });

  it('localizes structured keychain errors with detail message keys', () => {
    const message = getLocalizedErrorMessage(
      {
        message: 'Keychain is unavailable',
        data: {
          appErrorCode: 'KEYCHAIN_UNAVAILABLE',
          messageKey: 'error.keychainUnavailable',
          detailMessageKey: 'error.keychainHint.translocation',
          reportToSentry: true,
          metadata: {
            hint: 'HINT_APP_TRANSLOCATION',
          },
        },
      },
      createT(),
    );

    expect(message).toBe(
      "Can't access saved sign-in information right now. Move the app to the Applications folder, then open it again.",
    );
  });

  it('does not localize raw keychain error codes without structured data', () => {
    const message = getLocalizedErrorMessage(
      {
        message: 'Internal server error',
        data: {
          backendMessage: 'ERR_KEYCHAIN_UNAVAILABLE|HINT_APP_TRANSLOCATION',
        },
      },
      createT(),
    );

    expect(message).toBe('Internal server error');
  });

  it('localizes backend messages passed through ORPC data', () => {
    const message = getLocalizedErrorMessage(
      {
        message: 'Internal server error',
        data: {
          appErrorCode: 'DATA_MIGRATION_FAILED',
          messageKey: 'error.dataMigrationFailed',
          detailMessageKey: 'error.dataMigrationHint.relogin',
          reportToSentry: true,
          backendMessage: 'Data migration failed',
        },
      },
      createT(),
    );

    expect(message).toBe(
      "Can't read accounts saved by an earlier version. Please re-login or re-add your accounts.",
    );
  });

  it('does not localize raw cloud account token refresh text without structured data', () => {
    const rawMessage = 'Token refresh failed for user@example.com. Please try logging in again.';
    const message = getLocalizedErrorMessage(new Error(rawMessage), createT());

    expect(message).toBe(rawMessage);
  });

  it('does not localize raw cloud account token refresh backend messages without structured data', () => {
    const rawMessage = 'Token refresh failed for user@example.com. Please try logging in again.';
    const message = getLocalizedErrorMessage(
      {
        message: 'Internal server error',
        data: {
          backendMessage: rawMessage,
        },
      },
      createT(),
    );

    expect(message).toBe('Internal server error');
  });

  it('prefers structured app error message keys from ORPC data', () => {
    const message = getLocalizedErrorMessage(
      {
        message: 'Cloud account login expired',
        data: {
          appErrorCode: 'CLOUD_ACCOUNT_LOGIN_EXPIRED',
          messageKey: 'error.cloudAccountLoginExpired',
          reportToSentry: false,
          backendMessage: 'Cloud account login expired',
        },
      },
      createT(),
    );

    expect(message).toBe(CLOUD_ACCOUNT_LOGIN_EXPIRED_MESSAGE);
  });

  it('identifies data migration failures passed through ORPC data', () => {
    expect(
      isDataMigrationError({
        message: 'Internal server error',
        data: {
          appErrorCode: 'DATA_MIGRATION_FAILED',
          messageKey: 'error.dataMigrationFailed',
          detailMessageKey: 'error.dataMigrationHint.relogin',
          reportToSentry: true,
        },
      }),
    ).toBe(true);

    expect(
      isDataMigrationError({
        message: 'Internal server error',
        data: {
          backendMessage: 'Data migration failed',
        },
      }),
    ).toBe(false);
  });
});

describe('getErrorDetailsText', () => {
  it('shows backend stack details from ORPC data', () => {
    const details = getErrorDetailsText({
      message: 'Internal server error',
      data: {
        requestPath: '["cloud","listCloudAccounts"]',
        backendCode: 'INTERNAL_SERVER_ERROR',
        backendStatus: 500,
        backendMessage: 'Data migration failed',
        backendStack: 'Error: Data migration failed\n    at decryptWithMigration',
      },
    });

    expect(details).toContain('Request path: ["cloud","listCloudAccounts"]');
    expect(details).toContain('Backend message: Data migration failed');
    expect(details).toContain('at decryptWithMigration');
  });
});
