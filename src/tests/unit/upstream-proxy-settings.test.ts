import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpstreamProxySettings } from '@/modules/config/components/UpstreamProxySettings';
import { serviceConfigPlaceholder } from '@/modules/config/settings-change';

const api = vi.hoisted(() => ({
  writeSecret: vi.fn(),
  update: vi.fn(),
  revealSecret: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('@/ipc/manager', () => ({ ipc: { client: { config: { service: api } } } }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: api.toast }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

beforeEach(() => {
  vi.resetAllMocks();
  const result = { state: 'applied', snapshot: serviceConfigPlaceholder() };
  api.writeSecret.mockResolvedValue(result);
  api.update.mockResolvedValue(result);
  api.revealSecret.mockResolvedValue({ value: 'http://localhost:7890' });
});
afterEach(cleanup);

const proxy = (enabled: boolean, configured: boolean) => ({
  upstream_proxy: { enabled },
  upstream_proxy_configured: configured,
});

describe('upstream proxy settings', () => {
  it('shows a configuration-specific error if the saved address disappears before enabling', async () => {
    api.update.mockRejectedValueOnce({ data: { configCode: 'invalid-input' } });
    render(
      createElement(UpstreamProxySettings, {
        proxy: proxy(false, true),
        available: true,
        onSaved: vi.fn(async () => {}),
      }),
    );
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() =>
      expect(api.toast).toHaveBeenCalledExactlyOnceWith({
        title: 'settings.proxy.configuration-invalid',
        variant: 'destructive',
      }),
    );
  });

  it('allows entering and saving an address while disabled, then explicit enabling', async () => {
    const onSaved = vi.fn(async () => {});
    const view = render(
      createElement(UpstreamProxySettings, {
        proxy: proxy(false, false),
        available: true,
        onSaved,
      }),
    );
    const input = screen.getByLabelText('settings.proxy.url');
    expect(input).toHaveProperty('disabled', false);
    expect(screen.getByRole('switch')).toHaveProperty('disabled', true);
    fireEvent.change(input, { target: { value: 'invalid-address' } });
    expect(screen.getByRole('alert').textContent).toBe('settings.proxy.url-invalid');
    expect(screen.getByRole('button', { name: 'settings.service-save' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.change(input, { target: { value: ' http://localhost:7890 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.service-save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(api.writeSecret).toHaveBeenCalledExactlyOnceWith({
      name: 'upstream-proxy',
      value: 'http://localhost:7890',
    });
    expect(api.update).not.toHaveBeenCalled();
    expect(input).toHaveProperty('value', '');

    view.rerender(
      createElement(UpstreamProxySettings, { proxy: proxy(false, true), available: true, onSaved }),
    );
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledExactlyOnceWith({
        proxy: { upstream_proxy: { enabled: true } },
      }),
    );
  });

  it('permits clearing an enabled proxy and shows the refreshed disabled state', async () => {
    const onSaved = vi.fn(async () => {});
    const view = render(
      createElement(UpstreamProxySettings, { proxy: proxy(true, true), available: true, onSaved }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'proxy.config.show_key' }));
    await waitFor(() =>
      expect(screen.getByLabelText('settings.proxy.url')).toHaveProperty(
        'value',
        'http://localhost:7890',
      ),
    );
    fireEvent.change(screen.getByLabelText('settings.proxy.url'), { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.service-save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(api.writeSecret).toHaveBeenCalledExactlyOnceWith({
      name: 'upstream-proxy',
      value: null,
    });
    view.rerender(
      createElement(UpstreamProxySettings, {
        proxy: proxy(false, false),
        available: true,
        onSaved,
      }),
    );
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('switch')).toHaveProperty('disabled', true);
  });

  it('warns about a legacy invalid enabled configuration and permits disabling it', async () => {
    render(
      createElement(UpstreamProxySettings, {
        proxy: proxy(true, false),
        available: true,
        onSaved: vi.fn(async () => {}),
      }),
    );
    expect(screen.getByRole('alert').textContent).toBe('settings.proxy.configuration-invalid');
    expect(screen.getByRole('switch')).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledExactlyOnceWith({
        proxy: { upstream_proxy: { enabled: false } },
      }),
    );
  });

  it('blocks duplicate interaction while saving and retains a failed draft for retry', async () => {
    const pending = Promise.withResolvers();
    api.writeSecret.mockReturnValueOnce(pending.promise);
    const onSaved = vi.fn(async () => {});
    render(
      createElement(UpstreamProxySettings, { proxy: proxy(false, true), available: true, onSaved }),
    );
    const input = screen.getByLabelText('settings.proxy.url');
    fireEvent.change(input, { target: { value: 'http://localhost:7890' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.service-save' }));
    expect(input).toHaveProperty('disabled', true);
    expect(screen.getByRole('switch')).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'settings.service-save' }));
    expect(api.writeSecret).toHaveBeenCalledOnce();
    await act(async () => pending.reject(new Error('synthetic private proxy details')));
    expect(input).toHaveProperty('value', 'http://localhost:7890');
    expect(api.toast).toHaveBeenCalledExactlyOnceWith({
      title: 'settings.service-unavailable',
      variant: 'destructive',
    });
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'settings.service-save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  });
});
