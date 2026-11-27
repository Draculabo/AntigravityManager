import { describe, expect, it } from 'vitest';
import en from '@/localization/en';
import fr from '@/localization/fr';
import ja from '@/localization/ja';
import ptBR from '@/localization/pt-BR';
import ru from '@/localization/ru';
import tr from '@/localization/tr';
import vi from '@/localization/vi';
import zhCN from '@/localization/zh-CN';
import { mergeLocaleCatalog, type LocaleCatalog } from '@/localization/locale-catalog';

function flatten(value: LocaleCatalog, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    return typeof child === 'string' ? [fullKey] : flatten(child, fullKey);
  });
}

describe('localization catalogs', () => {
  it('keeps every effective locale catalog aligned with English', () => {
    const expected = flatten(en).sort();
    for (const [locale, catalog] of Object.entries({ fr, ja, ptBR, ru, tr, vi, zhCN })) {
      const actual = flatten(mergeLocaleCatalog(en, catalog)).sort();
      expect(actual, locale).toEqual(expected);
    }
  });

  it.each(Object.entries({ fr, ja, ptBR, ru, tr, vi, zhCN }))(
    'translates the Traffic reasoning metric without English fallback in %s',
    (_locale, catalog) => {
      for (const key of ['usage-reasoning', 'usage-reasoning-source'] as const) {
        expect(catalog.traffic).toHaveProperty(key, expect.stringMatching(/\S/u));
        expect(catalog.traffic).not.toHaveProperty(key, en.traffic[key]);
      }
    },
  );
});
