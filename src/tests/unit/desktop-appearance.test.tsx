import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createInstance } from 'i18next';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopLanguageSynchronizer } from '@/modules/app-shell/actions/language';
import {
  DesktopAppearanceProvider,
  useDesktopAppearance,
} from '@/modules/app-shell/components/DesktopAppearanceProvider';
import { DesktopAppearanceSettings } from '@/modules/app-shell/components/DesktopAppearanceSettings';
import type { DesktopZoomCommand } from '@/modules/app-shell/desktop-appearance';
import {
  DesktopPreferencesSchema,
  type DesktopPreferencesUpdate,
} from '@/modules/config/service-config.schema';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import en from '@/localization/en';

const api = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
vi.mock('@/ipc/manager', () => ({ ipc: { client: { config: { desktop: api } } } }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  localStorage.clear();
  document.documentElement.lang = '';
});

async function fixture(initial: DesktopPreferencesUpdate = {}) {
  let stored = DesktopPreferencesSchema.strip().parse({
    ...DEFAULT_APP_CONFIG,
    language: 'en',
    ...initial,
  });
  const persist = async (patch: DesktopPreferencesUpdate) => {
    stored = { ...stored, ...patch };
    return stored;
  };
  api.load.mockImplementation(async () => stored);
  api.save.mockImplementation(persist);
  const setDesktopZoom = vi.fn();
  let menuListener: ((command: DesktopZoomCommand) => void) | undefined;
  vi.stubGlobal('electron', {
    setDesktopZoom,
    onDesktopZoomCommand: (listener: (command: DesktopZoomCommand) => void) => {
      menuListener = listener;
      return () => {
        menuListener = undefined;
      };
    },
  });
  const i18n = createInstance();
  await i18n.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en }, fr: { translation: {} }, vi: { translation: {} } },
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <DesktopAppearanceProvider>{children}</DesktopAppearanceProvider>
      </I18nextProvider>
    </QueryClientProvider>
  );
  return {
    wrapper,
    i18n,
    setDesktopZoom,
    persist,
    menu: (command: DesktopZoomCommand) => menuListener?.(command),
  };
}

describe('desktop appearance', () => {
  it('applies the saved profile instead of the stale renderer cache and renders labelled controls', async () => {
    localStorage.setItem('lang', 'en');
    const { wrapper, i18n, setDesktopZoom } = await fixture({
      language: 'fr-CA',
      zoom_percent: 125,
    });
    render(<DesktopAppearanceSettings />, { wrapper });
    await waitFor(() => expect(document.documentElement.lang).toBe('fr'));
    expect(i18n.language).toBe('fr');
    expect(localStorage.getItem('lang')).toBe('fr');
    expect(screen.getByRole('combobox', { name: 'Interface zoom' }).textContent).toContain('125');
    expect(setDesktopZoom).toHaveBeenLastCalledWith(125);
  });

  it('keeps the last selected language while earlier saves finish, and retries a failed selection', async () => {
    const { wrapper, persist } = await fixture();
    const first = Promise.withResolvers<void>();
    api.save
      .mockImplementationOnce(async (patch) => {
        await first.promise;
        return persist(patch);
      })
      .mockRejectedValueOnce(new Error('Disk write failed'));
    const { result } = renderHook(useDesktopAppearance, { wrapper });
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => {
      result.current.setLanguage('vi');
      result.current.setLanguage('fr');
    });
    await waitFor(() => expect(result.current.language).toBe('fr'));
    expect(document.documentElement.lang).toBe('en');
    await act(async () => first.resolve());
    await waitFor(() => expect(result.current.languageStatus).toBe('failed'));
    expect(api.save.mock.calls).toEqual([[{ language: 'vi' }], [{ language: 'fr' }]]);
    await waitFor(() => expect(document.documentElement.lang).toBe('vi'));
    expect(result.current.language).toBe('vi');
    act(() => result.current.retryLanguage());
    await waitFor(() => expect(document.documentElement.lang).toBe('fr'));
    expect(localStorage.getItem('lang')).toBe('fr');
    expect(api.save).toHaveBeenLastCalledWith({ language: 'fr' });
  });

  it('uses one saved zoom for shortcut, menu and settings, and preserves editing keys', async () => {
    const { wrapper, setDesktopZoom, menu } = await fixture();
    const { result } = renderHook(useDesktopAppearance, { wrapper });
    const input = render(<input aria-label="Editor" />).getByRole('textbox');
    await waitFor(() => expect(setDesktopZoom).toHaveBeenLastCalledWith(100));
    expect(fireEvent.keyDown(input, { key: '+', ctrlKey: true })).toBe(true);
    expect(api.save).not.toHaveBeenCalled();
    act(() => {
      fireEvent.keyDown(document.body, { key: '=', ctrlKey: true });
      fireEvent.keyDown(document.body, { key: '+', ctrlKey: true });
    });
    await waitFor(() => expect(setDesktopZoom).toHaveBeenLastCalledWith(125));
    expect(result.current.zoom).toBe(125);
    act(() => menu('reset'));
    await waitFor(() => expect(setDesktopZoom).toHaveBeenLastCalledWith(100));
    act(() => result.current.setZoom(150));
    await waitFor(() => expect(setDesktopZoom).toHaveBeenLastCalledWith(150));
    fireEvent.keyDown(document.body, { key: '+', ctrlKey: true });
    expect(api.save.mock.calls).toEqual([
      [{ zoom_percent: 110 }],
      [{ zoom_percent: 125 }],
      [{ zoom_percent: 100 }],
      [{ zoom_percent: 150 }],
    ]);
  });

  it('serializes slow translation work and publishes only the current document language and cache', async () => {
    const first = Promise.withResolvers<never>();
    const translations = { language: 'vi', changeLanguage: vi.fn() };
    translations.changeLanguage.mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const sync = createDesktopLanguageSynchronizer(translations);
    const older = sync('en');
    await Promise.resolve();
    const newest = sync('fr');
    expect(translations.changeLanguage.mock.calls).toEqual([['en']]);
    first.reject(new Error('Old translation failed'));
    await expect(older).rejects.toThrow('Old translation failed');
    await newest;
    expect(document.documentElement.lang).toBe('fr');
    expect(localStorage.getItem('lang')).toBe('fr');
  });
});
