import { createElement, type ReactNode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QUERY_KEYS, useRefreshQuota } from '@/modules/cloud-account/hooks/useCloudAccounts';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import type { CloudQuotaBucket } from '@/modules/cloud-account/types';

const { refreshAccountQuota } = vi.hoisted(() => ({ refreshAccountQuota: vi.fn() }));
vi.mock('@/modules/cloud-account/actions/cloud', () => ({ refreshAccountQuota }));

const start = Date.parse('2026-10-17T00:00:00Z');
let client: QueryClient;

function bucket(window: string, offset: number): CloudQuotaBucket {
  return {
    bucket_id: window,
    window,
    remaining_fraction: 0.1,
    reset_time: new Date(start + offset).toISOString(),
    observed_at: start - 1000,
  };
}

function account(id: string, buckets: CloudQuotaBucket[]): CloudAccountView {
  return {
    id,
    provider: 'google',
    email: `${id}@example.test`,
    created_at: 1,
    last_used: 1,
    status: 'active',
    quota: { models: {}, quota_groups: [{ display_name: 'Gemini Models', buckets }] },
    proxy_configured: false,
  };
}

function renderRefresh(accounts: CloudAccountView[]) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  }
  return renderHook(({ current }) => useRefreshQuota(current), {
    wrapper: Wrapper,
    initialProps: { current: accounts },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  client = new QueryClient();
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.resetAllMocks();
  vi.useRealTimers();
});

it('refreshes only accounts with a due weekly reset and combines their simultaneous resets', async () => {
  const weekly = account('weekly', [bucket('weekly', 2000), bucket('7d', 2000)]);
  const fiveHour = account('five-hour', [bucket('5h', 1000)]);
  const current = account('confirmed', [{ ...bucket('weekly', 2000), observed_at: start + 2000 }]);
  const refreshed = account('weekly', [
    { ...bucket('weekly', 604_802_000), remaining_fraction: 1, observed_at: start + 2000 },
  ]);
  refreshAccountQuota.mockResolvedValue(refreshed);
  renderRefresh([weekly, fiveHour, current]);

  await act(() => vi.advanceTimersByTimeAsync(1999));
  expect(refreshAccountQuota).not.toHaveBeenCalled();

  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(refreshAccountQuota.mock.calls.map(([input]) => input)).toEqual([{ accountId: 'weekly' }]);
  expect(client.getQueryData(QUERY_KEYS.cloudAccounts)).toEqual([refreshed]);
});

it('catches up at page entry and remembers failed attempts across page navigation', async () => {
  const stale = account('stale', [bucket('weekly', -500), bucket('7d', 3000)]);
  refreshAccountQuota.mockRejectedValue(new Error('Synthetic refresh failure'));
  const view = renderRefresh([stale]);

  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(refreshAccountQuota.mock.calls.map(([input]) => input)).toEqual([{ accountId: 'stale' }]);
  view.unmount();
  renderRefresh([stale]);

  await act(() => vi.advanceTimersByTimeAsync(2999));
  expect(refreshAccountQuota).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(refreshAccountQuota.mock.calls.map(([input]) => input)).toEqual([
    { accountId: 'stale' },
    { accountId: 'stale' },
  ]);
});
