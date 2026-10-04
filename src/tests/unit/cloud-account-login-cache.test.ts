// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  QUERY_KEYS,
  useCloudAccounts,
  useStartGoogleAuthFlow,
} from '@/modules/cloud-account/hooks/useCloudAccounts';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';

const mocks = vi.hoisted(() => ({
  listCloudAccounts: vi.fn(),
  startAuthFlow: vi.fn(),
}));

vi.mock('@/ipc/manager', () => ({
  ipc: {
    client: {
      cloud: {
        listCloudAccounts: mocks.listCloudAccounts,
        startAuthFlow: mocks.startAuthFlow,
      },
    },
  },
}));

const account: CloudAccountView = {
  id: 'new-account',
  provider: 'google',
  email: 'new@example.com',
  created_at: 1,
  last_used: 1,
  status: 'active',
  proxy_configured: false,
};

describe('useStartGoogleAuthFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refreshes the account list after browser login completes', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    mocks.listCloudAccounts.mockResolvedValueOnce([]).mockResolvedValue([account]);
    mocks.startAuthFlow.mockResolvedValue(account);

    const wrapper = ({ children }: PropsWithChildren) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const { result } = renderHook(
      () => ({ accounts: useCloudAccounts(), login: useStartGoogleAuthFlow() }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.accounts.data).toEqual([]);
    });
    await act(async () => {
      await result.current.login.mutateAsync(undefined);
    });
    await waitFor(() => {
      expect(result.current.accounts.data).toEqual([account]);
    });
    expect(queryClient.getQueryData(QUERY_KEYS.cloudAccounts)).toEqual([account]);
    expect(mocks.startAuthFlow).toHaveBeenCalledExactlyOnceWith(undefined);
  });
});
