import { describe, expect, it } from 'vitest';
import { getDesktopStartupErrorTexts } from '@/modules/app-shell/services/desktop-startup-text';
import en from '@/localization/en';
import fr from '@/localization/fr';
import ru from '@/localization/ru';
import tr from '@/localization/tr';
import vi from '@/localization/vi';
import zh from '@/localization/zh-CN';

describe('desktop startup error texts', () => {
  it.each([
    ['zh-CN', zh],
    ['fr-FR', fr],
    ['ru-RU', ru],
    ['tr-TR', tr],
    ['vi-VN', vi],
    ['de-DE', en],
  ])('loads the %s fallback without the renderer translator', async (language, resource) => {
    for (const kind of [
      'core-unavailable',
      'account-data-unavailable',
      'already-running',
    ] as const) {
      expect(await getDesktopStartupErrorTexts(language, kind)).toEqual({
        title: resource.common[`${kind}-title`],
        body: resource.common[`${kind}-body`],
      });
    }
  });
});
