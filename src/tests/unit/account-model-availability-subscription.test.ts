import { createElement, type ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { useAccountModelAvailability } from '@/modules/cloud-account/hooks/useAccountModelAvailability';
import type { ipc } from '@/ipc/manager';

vi.mock('@/ipc/manager', () => ({
  ipc: { client: { gateway: { modelAvailability: async () => [] } } },
}));
type Availability = Awaited<ReturnType<typeof ipc.client.gateway.modelAvailability>>[number];
afterEach(cleanup);

it('keeps other account snapshots and renders stable when availability changes', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(['gateway', 'modelAvailability'], []);
  const renders = { a: vi.fn(), b: vi.fn() };
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  }
  const a = renderHook(
    () => {
      renders.a();
      return useAccountModelAvailability('account-a');
    },
    { wrapper: Wrapper },
  );
  const b = renderHook(
    () => {
      renders.b();
      return useAccountModelAvailability('account-b');
    },
    { wrapper: Wrapper },
  );
  const emptyA = a.result.current;
  const entry: Availability = {
    accountId: 'account-b',
    modelId: 'gemini-3-pro',
    detectedAt: 100,
    unavailableUntil: 200,
    reason: 'rate_limited',
    status: 429,
  };
  act(() => client.setQueryData(['gateway', 'modelAvailability'], [entry]));
  await waitFor(() => expect(b.result.current).toEqual([entry]));
  expect(a.result.current).toBe(emptyA);
  expect(renders.a).toHaveBeenCalledOnce();
  expect(renders.b).toHaveBeenCalledTimes(2);
  const snapshotB = b.result.current;
  act(() =>
    client.setQueryData(
      ['gateway', 'modelAvailability'],
      [entry, { ...entry, accountId: 'account-c' }],
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(a.result.current).toBe(emptyA);
  expect(b.result.current).toBe(snapshotB);
  expect(renders.a).toHaveBeenCalledOnce();
  expect(renders.b).toHaveBeenCalledTimes(2);
  act(() => client.setQueryData(['gateway', 'modelAvailability'], []));
  await waitFor(() => expect(b.result.current).toEqual([]));
  expect(renders.a).toHaveBeenCalledOnce();
  client.clear();
});
