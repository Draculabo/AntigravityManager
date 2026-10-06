// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { createElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/localization/en';
import { ProxyConfigSchema } from '@/modules/config/types';
import type { ServiceConfigSnapshot } from '@/modules/config/service-config.schema';
type ProxyConfig = ServiceConfigSnapshot['proxy'];

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  save: vi.fn(),
  error: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@/ipc/manager', () => ({
  ipc: { client: { gateway: { start: mocks.start, stop: mocks.stop } } },
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));

import { ProxyServiceControl } from '@/modules/proxy-gateway/components/ProxyServiceControl';

const i18n = createInstance();
const labels = en.proxy['risk-confirmation'];
const storedConfig = ProxyConfigSchema.parse({
  enabled: false,
  port: 8045,
  api_key: '',
  auto_start: false,
  anthropic_mapping: {},
  upstream_proxy: { enabled: false, url: '' },
});
const { api_key, upstream_proxy, ...publicConfig } = storedConfig;
const config: ProxyConfig = {
  ...publicConfig,
  upstream_proxy: { enabled: upstream_proxy.enabled },
  api_key_configured: !!api_key,
  upstream_proxy_configured: !!upstream_proxy.url,
};

function renderControl(proxyConfig: ProxyConfig = config) {
  return render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ProxyServiceControl, {
        config: proxyConfig,
        onConfigChange: mocks.save,
        onError: mocks.error,
      }),
    ),
  );
}

function requestStart() {
  fireEvent.click(screen.getByRole('button', { name: en.proxy.service.start }));
}

function confirmStart() {
  fireEvent.click(screen.getByRole('button', { name: labels.confirm }));
}

beforeAll(async () => {
  await i18n.init({ lng: 'en', resources: { en: { translation: en } } });
});
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  mocks.start.mockResolvedValue({ success: true, port: 8045 });
  mocks.stop.mockResolvedValue(undefined);
  mocks.save.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ProxyServiceControl', () => {
  it('shows the risk notice before the first start and starts only after confirmation', async () => {
    renderControl();
    requestStart();

    const dialog = screen.getByRole('dialog', { name: labels.title });
    expect(dialog.textContent).toContain(labels.description);
    expect(dialog.textContent).toContain(labels['account-advice']);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();

    confirmStart();
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledExactlyOnceWith({ ...config, enabled: true }),
    );
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith({ port: config.port });
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith(null);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each([labels.cancel, 'Close'])(
    'dismisses with %s without starting or recording consent',
    async (button) => {
      renderControl();
      requestStart();
      fireEvent.click(screen.getByRole('button', { name: button }));

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole('button', { name: en.proxy.service.start }),
        ),
      );
      expect(mocks.start).not.toHaveBeenCalled();
      expect(mocks.save).not.toHaveBeenCalled();
      requestStart();
      expect(screen.getByRole('dialog', { name: labels.title })).toBeTruthy();
    },
  );

  it('remembers explicit acknowledgement after the control is remounted', async () => {
    const view = renderControl();
    requestStart();
    confirmStart();
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    view.unmount();

    renderControl();
    requestStart();
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2));
    expect(mocks.start.mock.calls).toEqual([[{ port: 8045 }], [{ port: 8045 }]]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the control busy and sends only one start during an outstanding request', async () => {
    let complete!: (result: { success: true; port: number }) => void;
    mocks.start.mockImplementation(
      () =>
        new Promise<{ success: true; port: number }>((resolve) => {
          complete = resolve;
        }),
    );
    renderControl();
    requestStart();
    confirmStart();

    const button = screen.getByRole('button', { name: en.proxy.service.start });
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mocks.start).toHaveBeenCalledTimes(1);

    complete({ success: true, port: 8050 });
    await waitFor(() => expect(button.getAttribute('aria-busy')).toBe('false'));
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith({ ...config, port: 8050, enabled: true });
  });

  it('preserves address-in-use feedback and leaves the service disabled', async () => {
    mocks.start.mockResolvedValue({
      success: false,
      reason: 'address-in-use',
      port: 8045,
      message: 'Port unavailable',
    });
    renderControl();
    requestStart();
    confirmStart();

    const description = i18n.t('proxy.service.port_in_use_description', { port: 8045 });
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledExactlyOnceWith({
        title: en.proxy.service.port_in_use_title,
        description,
        variant: 'destructive',
      }),
    );
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith(description);
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith(config);
  });

  it('reports a rejected start and allows an explicit retry without repeating the notice', async () => {
    mocks.start.mockRejectedValueOnce(new Error('Gateway unavailable'));
    renderControl();
    requestStart();
    confirmStart();

    const button = screen.getByRole('button', { name: en.proxy.service.start });
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith('Gateway unavailable');
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith({
      title: en.proxy.service.start_failed,
      description: 'Gateway unavailable',
      variant: 'destructive',
    });

    requestStart();
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledExactlyOnceWith({ ...config, enabled: true }),
    );
    expect(mocks.start).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stops a running service without requiring the start acknowledgement', async () => {
    renderControl({ ...config, enabled: true });
    fireEvent.click(screen.getByRole('button', { name: en.proxy.service.stop }));

    await waitFor(() => expect(mocks.save).toHaveBeenCalledExactlyOnceWith(config));
    expect(mocks.stop).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('requires confirmation when storage is unavailable and permits the explicitly confirmed start', async () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('Storage unavailable');
    });
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('Storage unavailable');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const view = renderControl();
    requestStart();
    expect(mocks.start).not.toHaveBeenCalled();
    confirmStart();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: en.proxy.service.start }).getAttribute('aria-busy'),
      ).toBe('false'),
    );
    expect(mocks.save).toHaveBeenCalledTimes(1);
    view.unmount();

    renderControl();
    requestStart();
    expect(screen.getByRole('dialog', { name: labels.title })).toBeTruthy();
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });
});
