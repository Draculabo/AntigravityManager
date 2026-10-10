import type { ReactNode } from 'react';
import { createElement } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppConfig } from '@/modules/config/hooks/useAppConfig';
import { serviceConfigPlaceholder } from '@/modules/config/settings-change';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import {
  DesktopPreferencesSchema,
  type ServiceConfigUpdate,
} from '@/modules/config/service-config.schema';
import { DEFAULT_CLOUD_ACCOUNT_ALERT_POLICY } from '@/modules/cloud-account/services/cloud-account-alert-policy.schema';

const api = vi.hoisted(() => ({
  readService: vi.fn(),
  updateService: vi.fn(),
  readDesktop: vi.fn(),
  saveDesktop: vi.fn(),
  readPolicy: vi.fn(),
  updatePolicy: vi.fn(),
  toast: vi.fn(),
  translate: (key: string, fallback?: string) => fallback ?? key,
}));
vi.mock('@/ipc/manager', () => ({
  ipc: {
    client: {
      config: {
        service: { read: api.readService, update: api.updateService },
        desktop: { load: api.readDesktop, save: api.saveDesktop },
        accountAlertPolicy: { read: api.readPolicy, update: api.updatePolicy },
      },
    },
  },
}));
vi.mock('@/components/ui/use-toast', () => ({ toast: api.toast }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: api.translate }) }));

beforeEach(() => {
  vi.clearAllMocks();
  const preferences = DesktopPreferencesSchema.strip().parse(DEFAULT_APP_CONFIG);
  api.readDesktop.mockResolvedValue(preferences);
  api.saveDesktop.mockImplementation(async (patch) => ({ ...preferences, ...patch }));
  api.readService.mockResolvedValue(serviceConfigPlaceholder());
  api.readPolicy.mockResolvedValue(DEFAULT_CLOUD_ACCOUNT_ALERT_POLICY);
});
afterEach(cleanup);

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return { ...renderHook(() => useAppConfig(), { wrapper }), client };
}

describe('service settings in the renderer', () => {
  it('edits desktop preferences when service configuration and policy reads are unavailable', async () => {
    api.readService.mockRejectedValue(
      new Error('Settings are unavailable right now. Please try again.'),
    );
    api.readPolicy.mockRejectedValue(
      new Error('Settings are unavailable right now. Please try again.'),
    );
    const { result } = mount();
    await waitFor(() => expect(result.current.config).toBeDefined());
    await waitFor(() => expect(result.current.serviceLoading).toBe(false));
    expect(result.current.serviceAvailable).toBe(false);
    await act(async () => {
      await result.current.saveConfig({ ...result.current.config!, theme: 'light' });
    });
    expect(api.saveDesktop).toHaveBeenCalledExactlyOnceWith({ theme: 'light' });
    expect(api.updateService).not.toHaveBeenCalled();
    expect(api.updatePolicy).not.toHaveBeenCalled();
    expect(result.current.config?.theme).toBe('light');
  });

  it('sends only the intended patch when another service setting changes during debounce', async () => {
    const { result, client } = mount();
    await waitFor(() => expect(result.current.serviceAvailable).toBe(true));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.saveConfig({
        ...result.current.config!,
        proxy: { ...result.current.config!.proxy, request_timeout: 111 },
      });
    });
    const otherUpdate = {
      ...serviceConfigPlaceholder(),
      proxy: { ...serviceConfigPlaceholder().proxy, max_wait_seconds: 77 },
    };
    act(() => {
      client.setQueryData(['serviceConfig'], otherUpdate);
    });
    api.updateService.mockImplementation(async (patch: ServiceConfigUpdate) => ({
      state: 'restart-required',
      snapshot: { ...otherUpdate, proxy: { ...otherUpdate.proxy, ...patch.proxy } },
    }));
    await act(async () => {
      await pending;
    });
    expect(api.updateService).toHaveBeenCalledExactlyOnceWith({ proxy: { request_timeout: 111 } });
    expect(api.saveDesktop).not.toHaveBeenCalled();
    expect(result.current.config?.proxy).toMatchObject({
      request_timeout: 111,
      max_wait_seconds: 77,
    });
    expect(api.toast).toHaveBeenLastCalledWith({
      title: 'Settings saved. Turn the proxy off and back on to apply the changes.',
      description: undefined,
    });
  });

  it('routes alert edits solely to the account alert policy API', async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.accountAlertPolicyAvailable).toBe(true));
    api.updatePolicy.mockResolvedValue({
      ...DEFAULT_CLOUD_ACCOUNT_ALERT_POLICY,
      quota_alert_enabled: true,
    });
    await act(async () => {
      await result.current.saveConfig({ ...result.current.config!, quota_alert_enabled: true });
    });
    expect(api.updatePolicy).toHaveBeenCalledExactlyOnceWith({ quota_alert_enabled: true });
    expect(api.updateService).not.toHaveBeenCalled();
    expect(api.saveDesktop).not.toHaveBeenCalled();
  });

  it('shows translated guidance instead of a backend error when saving fails', async () => {
    const error = new Error('Internal service RPC failed');
    api.updateService.mockRejectedValue(error);
    const { result } = mount();
    await waitFor(() => expect(result.current.serviceAvailable).toBe(true));

    let save!: Promise<void>;
    act(() => {
      save = result.current.saveConfig({
        ...result.current.config!,
        proxy: { ...result.current.config!.proxy, request_timeout: 111 },
      });
    });
    await act(async () => {
      await expect(save).rejects.toThrow('Internal service RPC failed');
    });

    expect(api.toast).toHaveBeenLastCalledWith({
      error,
      title: 'settings.toast.saveFailed.title',
      description: 'settings.service-unavailable',
      variant: 'destructive',
    });
  });
});
