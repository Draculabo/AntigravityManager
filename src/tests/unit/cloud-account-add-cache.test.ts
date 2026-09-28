// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QUERY_KEYS, useAddGoogleAccount } from '@/modules/cloud-account/hooks/useCloudAccounts';
import type { CloudAccount } from '@/modules/cloud-account/types';

const mocks = vi.hoisted(() => ({
  addGoogleAccount: vi.fn(),
}));

vi.mock('@/ipc/manager', () => ({
  ipc: {
    client: {
      cloud: {
        addGoogleAccount: mocks.addGoogleAccount,
      },
    },
  },
}));

function createAccount(): CloudAccount {
  return {
    id: 'new-account',
    provider: 'google',
    email: 'new@example.com',
    token: {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
      expiry_timestamp: 4102444800,
      token_type: 'Bearer',
    },
    created_at: 1,
    last_used: 1,
  };
}

describe('useAddGoogleAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adds the returned account to the list cache immediately', async () => {
    const account = createAccount();
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    queryClient.setQueryData<CloudAccount[]>(QUERY_KEYS.cloudAccounts, []);
    mocks.addGoogleAccount.mockResolvedValue(account);

    const wrapper = ({ children }: PropsWithChildren) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const { result } = renderHook(() => useAddGoogleAccount(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ authCode: 'authorization-code' });
    });

    expect(queryClient.getQueryData(QUERY_KEYS.cloudAccounts)).toEqual([account]);
  });
});
