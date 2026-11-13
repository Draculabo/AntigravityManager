import type { i18n } from 'i18next';
import { LOCAL_STORAGE_KEYS } from '@/shared/constants';
import type { DesktopLanguage } from '../desktop-appearance';

export function createDesktopLanguageSynchronizer(
  translations: Pick<i18n, 'language' | 'changeLanguage'>,
) {
  let latest: DesktopLanguage;
  let pending: Promise<void> = Promise.resolve();

  return (language: DesktopLanguage): Promise<void> => {
    latest = language;
    const apply = pending.then(async () => {
      if (latest !== language) {
        return;
      }
      if (translations.language !== language) {
        await translations.changeLanguage(language);
      }
      if (latest === language) {
        document.documentElement.lang = language;
        // The cache accelerates the next paint. Desktop preferences own the saved value.
        localStorage.setItem(LOCAL_STORAGE_KEYS.LANGUAGE, language);
      }
    });
    pending = apply.catch(() => undefined);
    return apply;
  };
}
