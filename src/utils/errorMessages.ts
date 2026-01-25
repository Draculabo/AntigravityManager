import type { TFunction } from 'i18next';

const KEYCHAIN_ERROR_CODE = 'ERR_KEYCHAIN_UNAVAILABLE';
const KEYCHAIN_HINT_TRANSLOCATION = 'HINT_APP_TRANSLOCATION';
const KEYCHAIN_HINT_KEYCHAIN_DENIED = 'HINT_KEYCHAIN_DENIED';
const KEYCHAIN_HINT_SIGN_NOTARIZE = 'HINT_SIGN_NOTARIZE';

const KEYCHAIN_HINT_I18N_MAP: Record<string, string> = {
  [KEYCHAIN_HINT_TRANSLOCATION]: 'error.keychainHint.translocation',
  [KEYCHAIN_HINT_KEYCHAIN_DENIED]: 'error.keychainHint.keychainDenied',
  [KEYCHAIN_HINT_SIGN_NOTARIZE]: 'error.keychainHint.signNotarize',
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

export function getLocalizedErrorMessage(error: unknown, t: TFunction): string {
  if (error instanceof Error) {
    const rawMessage = error.message;
    const [code, hint] = rawMessage.split('|');
    if (code === KEYCHAIN_ERROR_CODE) {
      return resolveKeychainMessage(hint, t);
    }
    return rawMessage;
  }

  return String(error);
}
