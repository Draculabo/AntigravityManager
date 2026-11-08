// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { createElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/localization/en';
import { ProxyConfigSchema } from '@/modules/config/types';
import type { GatewayManualStartResult } from '@/modules/proxy-gateway/services/gateway-management.schema';
import type { ServiceConfigSnapshot } from '@/modules/config/service-config.schema';
type ProxyConfig = ServiceConfigSnapshot['proxy'];

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  status: vi.fn(),
  refresh: vi.fn(),
  error: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@/ipc/manager', () => ({
  ipc: {
    client: { gateway: { manualStart: mocks.start, manualStop: mocks.stop, status: mocks.status } },
  },
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
  network: {
    lan_access: false,
    ip_filter_mode: 'off',
    ip_allowlist: [],
    ip_blocklist: [],
    allowlist_takes_precedence: true,
    trusted_proxy_cidrs: [],
  },
  upstream_proxy: { enabled: false, url: '' },
});
const { api_key, upstream_proxy, ...publicConfig } = storedConfig;
const config: ProxyConfig = {
  ...publicConfig,
  upstream_proxy: { enabled: upstream_proxy.enabled },
  api_key_configured: !!api_key,
  upstream_proxy_configured: !!upstream_proxy.url,
};

function renderControl(running = false) {
  const client = new QueryClient();
  mocks.status.mockResolvedValue({ running });
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        I18nextProvider,
        { i18n },
        createElement(ProxyServiceControl, {
          config,
          running,
          onRuntimeChange: mocks.refresh,
          onError: mocks.error,
        }),
      ),
    ),
  );
}

function started(port: number): GatewayManualStartResult {
  return {
    operation: { success: true, port, base_url: `http://localhost:${port}` },
    persistence: { state: 'saved' },
  };
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
  mocks.start.mockResolvedValue(started(8045));
  mocks.stop.mockResolvedValue({ success: true, persistence: { state: 'saved' } });
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
    expect(mocks.refresh).not.toHaveBeenCalled();

    confirmStart();
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith());
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
      expect(mocks.refresh).not.toHaveBeenCalled();
      requestStart();
      expect(screen.getByRole('dialog', { name: labels.title })).toBeTruthy();
    },
  );

  it('remembers explicit acknowledgement after the control is remounted', async () => {
    const view = renderControl();
    requestStart();
    confirmStart();
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    view.unmount();

    renderControl();
    requestStart();
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(2));
    expect(mocks.start.mock.calls).toEqual([[{ port: 8045 }], [{ port: 8045 }]]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the control busy and sends only one start during an outstanding request', async () => {
    let complete!: (result: GatewayManualStartResult) => void;
    mocks.start.mockImplementation(
      () =>
        new Promise<GatewayManualStartResult>((resolve) => {
          complete = resolve;
        }),
    );
    renderControl();
    requestStart();
    confirmStart();

    const button = screen.getByRole('button', { name: en.proxy.service.start });
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mocks.start).toHaveBeenCalledTimes(1);

    mocks.status.mockResolvedValue({ running: true });
    complete(started(8050));
    await waitFor(() => expect(button.getAttribute('aria-busy')).toBe('false'));
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith();
    expect(screen.getByRole('button', { name: en.proxy.service.stop })).toBe(button);
  });

  it('preserves address-in-use feedback and leaves the service disabled', async () => {
    mocks.start.mockResolvedValue({
      operation: {
        success: false,
        reason: 'address-in-use',
        port: 8045,
        message: 'Port unavailable',
      },
      persistence: { state: 'not-attempted' },
    });
    renderControl();
    requestStart();
    confirmStart();

    const description = i18n.t('proxy.service.port_in_use_description', { port: 8045 });
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledExactlyOnceWith({
        title: en.proxy.service.start_failed,
        description,
        variant: 'destructive',
      }),
    );
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith(description);
    expect(screen.getByRole('button', { name: en.proxy.service.start })).toBeTruthy();
  });

  it('reports a rejected start and allows an explicit retry without repeating the notice', async () => {
    const error = new Error('Gateway unavailable');
    mocks.start.mockRejectedValueOnce(error);
    renderControl();
    requestStart();
    confirmStart();

    const button = screen.getByRole('button', { name: en.proxy.service.start });
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    const description = en.proxy.service['operation-failed'];
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith(description);
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith({
      error,
      title: description,
      variant: 'destructive',
    });
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith();

    requestStart();
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(2));
    expect(mocks.start).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stops a running service without requiring the start acknowledgement', async () => {
    renderControl(true);
    mocks.status.mockResolvedValueOnce({ running: true }).mockResolvedValue({ running: false });
    fireEvent.click(screen.getByRole('button', { name: en.proxy.service.stop }));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith());
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
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    view.unmount();

    renderControl();
    requestStart();
    expect(screen.getByRole('dialog', { name: labels.title })).toBeTruthy();
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });
});
