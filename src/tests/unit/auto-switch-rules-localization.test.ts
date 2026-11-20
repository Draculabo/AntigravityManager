import { expect, it } from 'vitest';
import i18n from 'i18next';
import en from '@/localization/en';
import '@/localization/i18n';
import { DESKTOP_LANGUAGES } from '@/modules/app-shell/desktop-appearance';

const messages = {
  ...Object.fromEntries(
    Object.entries(en.settings.autoSwitchModels).map(([key, value]) => [
      `settings.autoSwitchModels.${key}`,
      value,
    ]),
  ),
  'settings.modelVisibility.reset': en.settings.modelVisibility.reset,
  'settings.providerGroupings.models': en.settings.providerGroupings.models,
  'common.loading': en.common.loading,
};

it.each(DESKTOP_LANGUAGES)('provides localized auto-switch rules in %s', (language) => {
  for (const [messageKey, source] of Object.entries(messages)) {
    const message: unknown = i18n.getResource(language, 'translation', messageKey);
    expect(message, `${language}: ${messageKey}`).toMatch(/\S/u);
    if (language !== 'en') {
      expect(message, `${language}: ${messageKey}`).not.toBe(source);
    }
  }
});
