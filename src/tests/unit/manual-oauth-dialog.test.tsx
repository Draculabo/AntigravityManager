/** @vitest-environment happy-dom */
import { cleanup, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountOAuthPanel } from '@/modules/cloud-account/components/CloudAccountOAuthPanel';
import { mergeLocaleCatalog } from '@/localization/locale-catalog';
import en from '@/localization/en';
import zhCn from '@/localization/zh-CN';
import fr from '@/localization/fr';
import ja from '@/localization/ja';
import ptBr from '@/localization/pt-BR';
import ru from '@/localization/ru';
import tr from '@/localization/tr';
import viCatalog from '@/localization/vi';

vi.mock('@/modules/cloud-account/hooks/useCloudAccounts', () => ({
  useOAuthClients: () => ({ isPending: false }),
  useSetActiveOAuthClient: () => ({ isPending: false }),
}));
vi.mock('@/modules/cloud-account/actions/cloud', () => ({
  prepareOAuthSession: () => Promise.resolve({ sessionId: 'synthetic-session' }),
  waitForOAuthSession: () => new Promise(() => {}),
  cancelOAuthSession: () => Promise.resolve(),
}));

const catalogs = [
  { language: 'en', catalog: en },
  { language: 'zh-CN', catalog: zhCn },
  { language: 'fr', catalog: fr },
  { language: 'ja', catalog: ja },
  { language: 'pt-BR', catalog: ptBr },
  { language: 'ru', catalog: ru },
  { language: 'tr', catalog: tr },
  { language: 'vi', catalog: viCatalog },
];

afterEach(cleanup);

describe('manual OAuth input copy', () => {
  it.each(catalogs)('renders callback guidance in $language', async ({ language, catalog }) => {
    const i18n = createInstance();
    await i18n.init({
      lng: language,
      fallbackLng: false,
      resources: { [language]: { translation: mergeLocaleCatalog(en, catalog) } },
      interpolation: { escapeValue: false },
    });
    const sessionQueueRef = { current: Promise.resolve() };
    render(
      <I18nextProvider i18n={i18n}>
        <CloudAccountOAuthPanel sessionQueueRef={sessionQueueRef} onAuthorized={vi.fn()} />
      </I18nextProvider>,
    );

    const t = i18n.getFixedT(language);
    await screen.findByText(t('cloud.add-flow.browser-instructions'));
    const help = t('cloud.add-flow.callback-help');
    expect(help).not.toBe('cloud.add-flow.callback-help');
    expect(screen.getByText(help)).toBeTruthy();
    const input = screen.getByLabelText(t('cloud.add-flow.callback-label'));
    expect(input.getAttribute('maxlength')).toBe('2048');
    expect(input.getAttribute('aria-describedby')).toBe('add-account-callback-help');
    expect(t('cloud.toast.addFailed.codes.invalid-manual-input')).not.toContain('cloud.');
  });
});
