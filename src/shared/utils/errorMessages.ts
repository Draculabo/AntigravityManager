import type { TFunction } from 'i18next';
import { isObjectLike } from 'lodash-es';

const KEYCHAIN_ERROR_CODE = 'ERR_KEYCHAIN_UNAVAILABLE';
const KEYCHAIN_HINT_TRANSLOCATION = 'HINT_APP_TRANSLOCATION';
const KEYCHAIN_HINT_KEYCHAIN_DENIED = 'HINT_KEYCHAIN_DENIED';
const KEYCHAIN_HINT_SIGN_NOTARIZE = 'HINT_SIGN_NOTARIZE';
const DATA_MIGRATION_ERROR_CODE = 'ERR_DATA_MIGRATION_FAILED';
const DATA_MIGRATION_HINT_RELOGIN = 'HINT_RELOGIN';
const DATA_MIGRATION_HINT_CLEAR_DATA = 'HINT_CLEAR_DATA';
const ANTIGRAVITY_STORAGE_JSON_NOT_FOUND = 'storage_json_not_found';

const KEYCHAIN_HINT_I18N_MAP: Record<string, string> = {
  [KEYCHAIN_HINT_TRANSLOCATION]: 'error.keychainHint.translocation',
  [KEYCHAIN_HINT_KEYCHAIN_DENIED]: 'error.keychainHint.keychainDenied',
  [KEYCHAIN_HINT_SIGN_NOTARIZE]: 'error.keychainHint.signNotarize',
};

const DATA_MIGRATION_HINT_I18N_MAP: Record<string, string> = {
  [DATA_MIGRATION_HINT_RELOGIN]: 'error.dataMigrationHint.relogin',
  [DATA_MIGRATION_HINT_CLEAR_DATA]: 'error.dataMigrationHint.clearData',
};

function resolveKeychainMessage(hintCode: string | undefined, t: TFunction): string {
  const base = t('error.keychainUnavailable');
  if (!hintCode) {
    return base;
  }

  const hintKey = KEYCHAIN_HINT_I18N_MAP[hintCode];
  if (!hintKey) {
    return base;
  }

  return `${base} ${t(hintKey)}`;
}

function resolveDataMigrationMessage(hintCode: string | undefined, t: TFunction): string {
  const base = t('error.dataMigrationFailed');
  if (!hintCode) {
    return base;
  }

  const hintKey = DATA_MIGRATION_HINT_I18N_MAP[hintCode];
  if (!hintKey) {
    return base;
  }

  return `${base} ${t(hintKey)}`;
}

function resolveApplicationMessage(rawMessage: string, t: TFunction): string | null {
  if (rawMessage.includes(ANTIGRAVITY_STORAGE_JSON_NOT_FOUND)) {
    return t('error.antigravityStorageJsonNotFound', {
      defaultValue:
        'Antigravity storage.json was not found. Open the target Antigravity app and sign in once, then try switching again.',
    });
  }

  return null;
}

export function getLocalizedErrorMessage(error: unknown, t: TFunction): string {
  if (error instanceof Error) {
    const rawMessage = error.message;
    const [code, hint] = rawMessage.split('|');
    if (code === KEYCHAIN_ERROR_CODE) {
      return resolveKeychainMessage(hint, t);
    }
    if (code === DATA_MIGRATION_ERROR_CODE) {
      return resolveDataMigrationMessage(hint, t);
    }
    const applicationMessage = resolveApplicationMessage(rawMessage, t);
    if (applicationMessage) {
      return applicationMessage;
    }
    return rawMessage;
  }

  if (isObjectLike(error)) {
    const rawMessage = String((error as { message?: unknown }).message ?? '');
    const [code, hint] = rawMessage.split('|');
    if (code === KEYCHAIN_ERROR_CODE) {
      return resolveKeychainMessage(hint, t);
    }
    if (code === DATA_MIGRATION_ERROR_CODE) {
      return resolveDataMigrationMessage(hint, t);
    }
    const applicationMessage = resolveApplicationMessage(rawMessage, t);
    if (applicationMessage) {
      return applicationMessage;
    }
    if (rawMessage) {
      return rawMessage;
    }
  }

  return String(error);
}
