// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '@/localization/en';
import zhCn from '@/localization/zh-CN';
import fr from '@/localization/fr';
import ptBr from '@/localization/pt-BR';
import ru from '@/localization/ru';
import tr from '@/localization/tr';
import viCatalog from '@/localization/vi';
import type { ModelAliasRoute } from '@/modules/config/types';
import { ModelAliasEditor } from '@/modules/proxy-gateway/components/ModelAliasEditor';

const catalogs = [
  { language: 'en', catalog: en },
  { language: 'zh-CN', catalog: zhCn },
  { language: 'fr', catalog: fr },
  { language: 'pt-BR', catalog: ptBr },
  { language: 'ru', catalog: ru },
  { language: 'tr', catalog: tr },
  { language: 'vi', catalog: viCatalog },
];
const original: ModelAliasRoute[] = [
  { alias: 'my-opus', target: 'claude-opus-4-6-thinking', enabled: true },
];

afterEach(cleanup);

async function mount(routes = original, entry = catalogs[0]) {
  const i18n = createInstance();
  await i18n.init({
    lng: entry.language,
    fallbackLng: false,
    resources: { [entry.language]: { translation: entry.catalog } },
    interpolation: { escapeValue: false },
  });
  const onSave = vi.fn<(next: ModelAliasRoute[]) => Promise<void>>(async () => {});
  const view = render(
    <I18nextProvider i18n={i18n}>
      <ModelAliasEditor routes={routes} onSave={onSave} />
    </I18nextProvider>,
  );
  return { ...view, onSave, copy: entry.catalog.proxy.mapping };
}

describe('model alias settings', () => {
  it.each(catalogs)(
    'renders translated publication and automatic strategy controls in $language',
    async (entry) => {
      const { container, copy, onSave } = await mount(
        [{ alias: 'my-opus', target: 'auto:claude-opus', enabled: true }],
        entry,
      );
      expect(screen.getByText(copy['alias-rules-description'])).toBeTruthy();
      expect(screen.getByText(copy['auto-opus-description'])).toBeTruthy();
      expect(
        screen.getByRole('checkbox', { name: copy.published }).getAttribute('aria-checked'),
      ).toBe('false');
      expect(
        screen.getByRole('checkbox', { name: copy['route-enabled'] }).getAttribute('aria-checked'),
      ).toBe('true');
      expect(container.textContent).not.toContain('proxy.mapping.');
      expect(onSave).not.toHaveBeenCalled();
    },
  );

  it('saves hidden routing independently of enabled state and preserves untouched rows', async () => {
    const routes = [
      ...original,
      { alias: 'second', target: 'gemini-3-flash', enabled: false, published: false },
    ];
    const { copy, onSave } = await mount(routes);
    fireEvent.click(screen.getAllByRole('checkbox', { name: copy.published })[0]);
    fireEvent.click(screen.getByRole('button', { name: copy['save-rules'] }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledExactlyOnceWith([
        { ...original[0], published: false },
        routes[1],
      ]),
    );
    expect(routes[0]).toEqual(original[0]);
    expect(screen.getByRole('status').textContent).toBe(copy['rules-saved']);
  });

  it('uses automatic-target hidden default when a target is typed and allows explicit publication', async () => {
    const { copy, onSave } = await mount();
    fireEvent.change(screen.getByLabelText(copy['target-model']), {
      target: { value: 'auto:claude-opus' },
    });
    expect(
      screen.getByRole('checkbox', { name: copy.published }).getAttribute('aria-checked'),
    ).toBe('false');
    expect(screen.getByText(copy['auto-opus-description'])).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: copy.published }));
    fireEvent.click(screen.getByRole('button', { name: copy['save-rules'] }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledExactlyOnceWith([
        { ...original[0], target: 'auto:claude-opus', published: true },
      ]),
    );
  });

  it('never presents wildcard names as publishable', async () => {
    const { copy } = await mount([
      { alias: 'claude-*', target: 'gemini-3-flash', enabled: true, published: true },
    ]);
    const checkbox = screen.getByRole('checkbox', { name: copy.published });
    expect(checkbox.getAttribute('aria-checked')).toBe('false');
    expect(checkbox.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(copy['pattern-hidden'])).toBeTruthy();
  });

  it('adds, validates and trims rules', async () => {
    const { copy, onSave } = await mount([]);
    expect(screen.getByText(copy['no-rules'])).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: copy['add-rule'] }));
    expect(screen.getByRole('button', { name: copy['save-rules'] }).hasAttribute('disabled')).toBe(
      true,
    );
    fireEvent.change(screen.getByLabelText(copy['requested-model']), {
      target: { value: ' alias ' },
    });
    fireEvent.change(screen.getByLabelText(copy['target-model']), {
      target: { value: ' gemini-3-flash ' },
    });
    fireEvent.click(screen.getByRole('button', { name: copy['save-rules'] }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledExactlyOnceWith([
        { alias: 'alias', target: 'gemini-3-flash', enabled: true },
      ]),
    );
  });

  it('saves removal of the final alias as an empty list', async () => {
    const { copy, onSave } = await mount();
    fireEvent.click(
      screen.getByRole('button', { name: copy['remove-rule'].replace('{{index}}', '1') }),
    );
    expect(screen.getByText(copy['no-rules'])).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: copy['save-rules'] }));
    await waitFor(() => expect(onSave).toHaveBeenCalledExactlyOnceWith([]));
  });

  it('rejects duplicate names and keeps edits for an explicit retry after save failure', async () => {
    const { copy, onSave } = await mount();
    fireEvent.click(screen.getByRole('button', { name: copy['add-rule'] }));
    fireEvent.change(screen.getAllByLabelText(copy['requested-model'])[1], {
      target: { value: 'my-opus' },
    });
    fireEvent.change(screen.getAllByLabelText(copy['target-model'])[1], {
      target: { value: 'gemini-3-flash' },
    });
    expect(screen.getByRole('button', { name: copy['save-rules'] }).hasAttribute('disabled')).toBe(
      true,
    );
    fireEvent.click(
      screen.getByRole('button', { name: copy['remove-rule'].replace('{{index}}', '2') }),
    );
    fireEvent.click(screen.getByRole('checkbox', { name: copy.published }));
    onSave.mockRejectedValueOnce(new Error('Owner unavailable'));
    fireEvent.click(screen.getByRole('button', { name: copy['save-rules'] }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(copy['save-failed']));
    expect(
      screen.getByRole('checkbox', { name: copy.published }).getAttribute('aria-checked'),
    ).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: copy['save-rules'] }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(copy['rules-saved']));
    expect(onSave.mock.calls).toEqual([
      [[{ ...original[0], published: false }]],
      [[{ ...original[0], published: false }]],
    ]);
  });

  it('does not submit again while saving and lets users discard a pending edit', async () => {
    const { copy, onSave } = await mount();
    let complete: () => void = () => {};
    onSave.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    fireEvent.click(screen.getByRole('checkbox', { name: copy.published }));
    fireEvent.click(screen.getByRole('button', { name: copy['save-rules'] }));
    expect(
      screen
        .getByRole('button', { name: copy['saving-rules'] })
        .closest('fieldset')
        ?.hasAttribute('disabled'),
    ).toBe(true);
    expect(onSave).toHaveBeenCalledTimes(1);
    complete();
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
    fireEvent.change(screen.getByLabelText(copy['target-model']), {
      target: { value: 'changed-model' },
    });
    fireEvent.click(screen.getByRole('button', { name: copy['discard-rules'] }));
    expect(screen.getByLabelText(copy['target-model']).getAttribute('value')).toBe(
      original[0].target,
    );
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
