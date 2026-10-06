// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/localization/en';

const mocks = vi.hoisted(() => ({
  clearOpenCode: vi.fn(),
  openCodeStatus: vi.fn(),
  readOpenCodeConfig: vi.fn(),
  restoreOpenCode: vi.fn(),
  revokeOpenCodeKey: vi.fn(),
  syncOpenCode: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@/ipc/manager', () => ({
  ipc: {
    client: {
      gateway: {
        clearOpenCode: mocks.clearOpenCode,
        openCodeStatus: mocks.openCodeStatus,
        readOpenCodeConfig: mocks.readOpenCodeConfig,
        restoreOpenCode: mocks.restoreOpenCode,
        revokeOpenCodeKey: mocks.revokeOpenCodeKey,
        syncOpenCode: mocks.syncOpenCode,
      },
    },
  },
}));

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock('react-i18next', async () => {
  const { createInstance } = await import('i18next');
  const { default: resource } = await import('@/localization/en');
  const i18n = createInstance();
  await i18n.init({ lng: 'en', resources: { en: { translation: resource } } });
  return { useTranslation: () => ({ t: i18n.t.bind(i18n) }) };
});

import { OpenCodeSyncCard } from '@/modules/proxy-gateway/components/OpenCodeSyncCard';

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(OpenCodeSyncCard, {
        baseUrl: 'http://127.0.0.1:8045',
        models: [{ id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash' }],
      }),
    ),
  );
}

describe('OpenCodeSyncCard', () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.openCodeStatus.mockImplementation(async () => ({
      configPath: 'C:/Users/test/.config/opencode/opencode.jsonc',
      exists: true,
      hasBackup: true,
      isConfigured: true,
      isSynced: true,
      currentBaseUrl: 'http://127.0.0.1:8045/v1',
      hasAuthPlugin: false,
      keyConfigured: true,
      installed: true,
      version: '1.2.3',
      models: [{ id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash' }],
    }));
    mocks.readOpenCodeConfig.mockResolvedValue({
      configPath: 'C:/Users/test/.config/opencode/opencode.jsonc',
      fileName: 'opencode.jsonc',
      content: '{\n  "apiKey": "[REDACTED]"\n}\n',
    });
    mocks.restoreOpenCode.mockResolvedValue({ configPath: 'opencode.jsonc' });
    mocks.clearOpenCode.mockResolvedValue({ configPath: 'opencode.jsonc' });
    mocks.syncOpenCode.mockResolvedValue({ configPath: 'opencode.jsonc' });
  });

  it('requires confirmation before restoring the one-time backup', async () => {
    renderCard();

    await screen.findByText('C:/Users/test/.config/opencode/opencode.jsonc');
    fireEvent.click(screen.getByRole('button', { name: 'Restore backup' }));
    expect(mocks.restoreOpenCode).not.toHaveBeenCalled();
    expect(screen.getByText('Restore OpenCode backup?')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm restore' }));
    await waitFor(() => expect(mocks.restoreOpenCode).toHaveBeenCalledTimes(1));
  });

  it('shows the detected version and confirms removal of only the Manager connection', async () => {
    renderCard();

    expect(await screen.findByText(`${en['agent-tools'].installed} · 1.2.3`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: en['agent-tools'].remove }));
    expect(mocks.clearOpenCode).not.toHaveBeenCalled();
    expect(screen.getByText(en.proxy['open-code']['clear-confirm-title'])).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm clear' }));
    await waitFor(() =>
      expect(mocks.clearOpenCode).toHaveBeenCalledWith({
        baseUrl: 'http://127.0.0.1:8045',
        clearLegacy: false,
      }),
    );
  });

  it('persists the account-sync opt-in across model dialog openings', async () => {
    renderCard();

    await screen.findByText('C:/Users/test/.config/opencode/opencode.jsonc');
    fireEvent.click(screen.getByRole('button', { name: en['agent-tools'].update }));
    const syncAccounts = screen.getByRole('checkbox', {
      name: `${en.proxy['open-code']['sync-accounts']} ${en.proxy['open-code']['sync-accounts-description']}`,
    });
    expect(syncAccounts.getAttribute('data-state')).toBe('unchecked');
    fireEvent.click(syncAccounts);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm sync' }));

    await waitFor(() =>
      expect(mocks.syncOpenCode).toHaveBeenCalledWith({
        baseUrl: 'http://127.0.0.1:8045/v1',
        models: [{ id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash' }],
        syncAccounts: true,
      }),
    );
    await waitFor(() => expect(screen.queryByText('Choose OpenCode models')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: en['agent-tools'].update }));
    expect(
      screen
        .getByRole('checkbox', {
          name: `${en.proxy['open-code']['sync-accounts']} ${en.proxy['open-code']['sync-accounts-description']}`,
        })
        .getAttribute('data-state'),
    ).toBe('checked');
  });

  it('warns about another sign-in plugin and loads the private preview only when opened', async () => {
    mocks.openCodeStatus.mockImplementation(async () => ({
      configPath: 'C:/Users/test/.config/opencode/opencode.jsonc',
      exists: true,
      hasBackup: false,
      isConfigured: true,
      isSynced: true,
      currentBaseUrl: 'http://127.0.0.1:8045/v1',
      hasAuthPlugin: true,
      keyConfigured: true,
      installed: false,
      version: null,
      models: [],
    }));
    renderCard();

    expect(await screen.findByText(en['agent-tools']['plugin-notice'])).toBeTruthy();
    expect(mocks.readOpenCodeConfig).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'View configuration' }));
    expect(await screen.findByText('opencode.jsonc')).toBeTruthy();
    expect(await screen.findByText(/\[REDACTED\]/)).toBeTruthy();
    expect(mocks.readOpenCodeConfig).toHaveBeenCalledTimes(1);
  });
  it('offers a safe retry when the configuration preview cannot be read', async () => {
    mocks.readOpenCodeConfig.mockRejectedValueOnce(new Error('private-config-path'));
    renderCard();
    await screen.findByText('C:/Users/test/.config/opencode/opencode.jsonc');
    fireEvent.click(screen.getByRole('button', { name: en['agent-tools'].view }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      en.proxy['open-code']['config-load-failed'],
    );
    expect(screen.queryByText('private-config-path')).toBeNull();
    expect(
      screen.getByRole('button', { name: en.proxy['open-code']['copy-config'] }),
    ).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: en.action.retry }));
    await screen.findByText(/\[REDACTED\]/);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mocks.readOpenCodeConfig).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole('button', { name: en.proxy['open-code']['copy-config'] }),
    ).not.toHaveProperty('disabled', true);
  });
});
