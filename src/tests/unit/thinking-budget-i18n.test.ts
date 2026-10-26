import { describe, expect, it } from 'vitest';
import en from '@/localization/en';
import zhCn from '@/localization/zh-CN';
import ru from '@/localization/ru';
import vi from '@/localization/vi';
import tr from '@/localization/tr';
import fr from '@/localization/fr';

type Catalog = Record<string, unknown>;

function flatten(value: Catalog, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, item]) =>
    typeof item === 'object' && item !== null
      ? flatten(item as Catalog, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

function thinkingKeys(catalog: Catalog): Set<string> {
  return new Set(flatten(catalog).filter((key) => key.startsWith('settings.thinkingBudget')));
}

describe('thinking budget settings copy', () => {
  it('defines every English key in all six languages', () => {
    const reference = thinkingKeys(en as Catalog);
    expect(reference.size).toBeGreaterThan(0);
    const catalogs = { 'zh-CN': zhCn, ru, vi, tr, fr } as Record<string, Catalog>;
    for (const [language, catalog] of Object.entries(catalogs)) {
      const keys = thinkingKeys(catalog);
      expect(
        [...reference].filter((key) => !keys.has(key)),
        `${language} missing keys`,
      ).toEqual([]);
      expect(
        [...keys].filter((key) => !reference.has(key)),
        `${language} extra keys`,
      ).toEqual([]);
    }
  });
});
