import { describe, expect, it } from 'vitest';

import en from '@/localization/en';
import fr from '@/localization/fr';
import ru from '@/localization/ru';
import tr from '@/localization/tr';
import vi from '@/localization/vi';
import zhCn from '@/localization/zh-CN';
import ptBr from '@/localization/pt-BR';

const locales = [
  { code: 'en', card: en.cloud.card },
  { code: 'zh-CN', card: zhCn.cloud.card },
  { code: 'ru', card: ru.cloud.card },
  { code: 'vi', card: vi.cloud.card },
  { code: 'tr', card: tr.cloud.card },
  { code: 'fr', card: fr.cloud.card },
  { code: 'pt-BR', card: ptBr.cloud.card },
];

describe('cloud account validation translations', () => {
  it.each(locales)('defines every validation status and action in $code', ({ card }) => {
    expect(card.validationOAuthReauthRequired.trim()).not.toBe('');
    expect(card.validationRequired.trim()).not.toBe('');
    expect(card.completeValidation.trim()).not.toBe('');
  });
});
