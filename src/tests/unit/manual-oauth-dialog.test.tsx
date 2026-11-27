/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountOAuthPanel } from '@/modules/cloud-account/components/CloudAccountOAuthPanel';
import { prepareOAuthSession } from '@/modules/cloud-account/actions/cloud';
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
  useOAuthClients: () => ({
    isPending: false,
    data: [{ key: 'test-client', label: 'Test', is_active: true }],
  }),
  useSetActiveOAuthClient: () => ({ isPending: false }),
}));
vi.mock('@/modules/cloud-account/actions/cloud', () => ({
  prepareOAuthSession: vi.fn(() => Promise.resolve({ sessionId: 'synthetic-session' })),
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
  it('offers the safe diagnostic reference when preparing authorization fails', async () => {
    const diagnosticId = '11111111-1111-4111-8111-111111111111';
    vi.mocked(prepareOAuthSession).mockRejectedValueOnce({
      diagnostic: {
        schemaVersion: 1,
        diagnosticId,
        operation: 'google-login',
        stage: 'authorization-url',
        reason: 'proxy-configuration-invalid',
        accountCommit: 'not-attempted',
        reporting: { state: 'not-reported', reason: 'disabled' },
      },
    });
    const i18n = createInstance();
    await i18n.init({ lng: 'en', resources: { en: { translation: en } } });
    render(
      <I18nextProvider i18n={i18n}>
        <CloudAccountOAuthPanel
          sessionQueueRef={{ current: Promise.resolve() }}
          onAuthorized={vi.fn()}
        />
      </I18nextProvider>,
    );
    await screen.findByText('Check the upstream proxy settings, then retry.');
    const details = screen.getByText('Details').closest('details')!;
    expect(details.open).toBe(false);
    fireEvent.click(screen.getByText('Details'));
    expect(details.textContent).toContain(`Diagnostic ID: ${diagnosticId}`);
    expect(details.textContent).toContain('Reason: proxy-configuration-invalid');
  });

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
