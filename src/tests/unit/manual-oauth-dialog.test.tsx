// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountAuthDialog } from '@/modules/cloud-account/components/CloudAccountAuthDialog';
import en from '@/localization/en';
import zhCn from '@/localization/zh-CN';
import fr from '@/localization/fr';
import ptBr from '@/localization/pt-BR';
import ru from '@/localization/ru';
import tr from '@/localization/tr';
import viCatalog from '@/localization/vi';

const catalogs = [
  { language: 'en', catalog: en },
  { language: 'zh-CN', catalog: zhCn },
  { language: 'fr', catalog: fr },
  { language: 'pt-BR', catalog: ptBr },
  { language: 'ru', catalog: ru },
  { language: 'tr', catalog: tr },
  { language: 'vi', catalog: viCatalog },
];
afterEach(cleanup);

describe('manual OAuth input copy', () => {
  it.each(catalogs)(
    'renders callback guidance and preserves pasted input in $language',
    async ({ language, catalog }) => {
      const i18n = createInstance();
      await i18n.init({
        lng: language,
        fallbackLng: false,
        resources: { [language]: { translation: catalog } },
        interpolation: { escapeValue: false },
      });
      const change = vi.fn();
      const submit = vi.fn();
      render(
        <I18nextProvider i18n={i18n}>
          <CloudAccountAuthDialog
            open
            onOpenChange={vi.fn()}
            selectedOAuthClientKey=""
            oauthClients={[]}
            isOAuthClientsLoading={false}
            isSetActiveOAuthClientPending={false}
            isAddPending
            isCodeSubmitting={false}
            authCode="4/code"
            onOAuthClientChange={vi.fn()}
            onOpenGoogleAuthSignIn={vi.fn()}
            onAuthCodeChange={change}
            onSubmitAuthCode={submit}
          />
        </I18nextProvider>,
      );
      const copy = catalog.cloud.authDialog;
      expect(screen.getByText(copy.instruction)).toBeTruthy();
      expect(catalog.cloud.toast.addFailed.codes['invalid-manual-input']).not.toContain('cloud.');
      const input = screen.getByLabelText(copy.authCode);
      expect(input.getAttribute('maxlength')).toBe('2048');
      expect(input.getAttribute('aria-describedby')).toBe('oauth-manual-input-instruction');
      const callback = 'http://127.0.0.1:1234/oauth-callback?code=4%2Ftest&state=current';
      fireEvent.change(input, { target: { value: callback } });
      expect(change).toHaveBeenCalledExactlyOnceWith(callback);
      fireEvent.click(screen.getByRole('button', { name: copy.verify }));
      expect(submit).toHaveBeenCalledOnce();
    },
  );
});
