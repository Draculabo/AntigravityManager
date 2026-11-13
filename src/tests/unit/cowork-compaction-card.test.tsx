import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '@/localization/en';
import zhCn from '@/localization/zh-CN';
import ru from '@/localization/ru';
import viCatalog from '@/localization/vi';
import tr from '@/localization/tr';
import fr from '@/localization/fr';
import ptBr from '@/localization/pt-BR';
import { CoworkCompactionConfigSchema } from '@/modules/config/types';
import { CoworkCompactionCard } from '@/modules/proxy-gateway/components/CoworkCompactionCard';

const catalogs = [
  { language: 'en', catalog: en },
  { language: 'zh-CN', catalog: zhCn },
  { language: 'ru', catalog: ru },
  { language: 'vi', catalog: viCatalog },
  { language: 'tr', catalog: tr },
  { language: 'fr', catalog: fr },
  { language: 'pt-BR', catalog: ptBr },
];

afterEach(cleanup);

async function mount({ language, catalog }: (typeof catalogs)[number], apiKeyConfigured = true) {
  const i18n = createInstance();
  await i18n.init({
    lng: language,
    fallbackLng: false,
    resources: { [language]: { translation: catalog } },
    interpolation: { escapeValue: false },
  });
  const config = CoworkCompactionConfigSchema.parse({});
  const onChange = vi.fn(async () => {});
  const revealApiKey = vi.fn(async () => 'test-proxy-key');
  const view = render(
    <I18nextProvider i18n={i18n}>
      <CoworkCompactionCard
        config={config}
        apiKeyConfigured={apiKeyConfigured}
        revealApiKey={revealApiKey}
        onChange={onChange}
      />
    </I18nextProvider>,
  );
  return { ...view, config, onChange, revealApiKey, copy: catalog.proxy.config.compaction };
}

describe('Cowork compaction card localization', () => {
  it.each(catalogs)(
    'renders translated controls in $language without fallback resources',
    async (entry) => {
      const { container, copy, onChange, revealApiKey } = await mount(entry);
      for (const text of [
        copy.title,
        copy.description,
        copy['trusted-sources'],
        copy['trust-desc'],
        copy['no-trusted-sources'],
        copy['auto-desc'],
        copy['manual-desc'],
        copy['threshold-desc'],
      ]) {
        expect(screen.getByText(text)).toBeTruthy();
      }
      expect(
        screen.getByRole('button', { name: copy['trust-current-key'] }).hasAttribute('disabled'),
      ).toBe(false);
      expect(screen.getByRole('switch', { name: copy.auto }).getAttribute('aria-checked')).toBe(
        'false',
      );
      expect(screen.getByRole('switch', { name: copy.manual }).getAttribute('aria-checked')).toBe(
        'false',
      );
      expect(screen.getByRole('spinbutton', { name: copy.threshold }).getAttribute('value')).toBe(
        '200000',
      );
      expect(container.textContent).not.toMatch(/proxy\.(?:config\.)?compaction\./u);
      expect(onChange).not.toHaveBeenCalled();
      expect(revealApiKey).not.toHaveBeenCalled();
    },
  );

  it('preserves manual save and retry behavior with Chinese labels', async () => {
    const { config, copy, onChange } = await mount({ language: 'zh-CN', catalog: zhCn });
    expect(screen.getByText('Cowork 上下文压缩')).toBeTruthy();
    onChange.mockRejectedValueOnce(new Error('Owner unavailable'));
    fireEvent.click(screen.getByRole('switch', { name: '启用手动 /compact 协作' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(copy['save-failed']),
    );
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...config, manual_enabled: true });
    fireEvent.click(screen.getByRole('button', { name: copy.retry }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(onChange.mock.calls).toEqual([
      [{ ...config, manual_enabled: true }],
      [{ ...config, manual_enabled: true }],
    ]);
    expect(screen.getByRole('switch', { name: copy.auto }).getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  it('explains the missing API key and disables trusting it', async () => {
    const { copy, revealApiKey } = await mount({ language: 'en', catalog: en }, false);
    expect(screen.getByText(copy['key-required'])).toBeTruthy();
    const button = screen.getByRole('button', { name: copy['trust-current-key'] });
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(button);
    expect(revealApiKey).not.toHaveBeenCalled();
  });
});
