import { createInstance } from 'i18next';
import { expect, it } from 'vitest';
import en from '@/localization/en';
import zhCN from '@/localization/zh-CN';
import ru from '@/localization/ru';
import fr from '@/localization/fr';
import ptBR from '@/localization/pt-BR';
import tr from '@/localization/tr';
import vi from '@/localization/vi';

const catalogs = { en, 'zh-CN': zhCN, ru, fr, 'pt-BR': ptBR, tr, vi };
for (const [language, catalog] of Object.entries(catalogs)) {
  it(`resolves traffic diagnostic controls and stages without fallback in ${language}`, async () => {
    const i18n = createInstance();
    await i18n.init({
      lng: language,
      fallbackLng: false,
      resources: { [language]: { translation: catalog } },
    });
    const keys = [
      'export-har',
      'har-exporting',
      'har-export-saved',
      'har-export-failed',
      'har-export-wait',
      'attempt-timing.upload-finished',
      'attempt-timing.response-headers',
      'attempt-timing.first-byte',
      'attempt-timing.first-output',
      'attempt-timing.previous-attempts',
      'attempt-timing.description',
    ];
    for (const name of keys) {
      const key = `traffic.${name}`;
      expect(i18n.t(key)).not.toBe(key);
      expect(i18n.t(key).trim().length).toBeGreaterThan(0);
    }
  });
}
