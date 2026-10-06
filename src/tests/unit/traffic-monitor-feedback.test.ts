import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TrafficMonitorPage } from '@/modules/proxy-gateway/traffic-monitor/TrafficMonitorPage';

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/ipc/manager', () => ({
  ipc: {
    client: {
      gateway: {
        auditList: mocks.read,
        auditStats: async () => ({ rows: 1, databaseBytes: 1000, droppedCount: 0 }),
        auditFilterOptions: async () => ({ accountIds: [], modelFamilies: [] }),
      },
    },
  },
}));
vi.mock('@/modules/proxy-gateway/traffic-monitor/components/TrafficTable', () => ({
  TrafficTable: () => createElement('div', null, 'Previously loaded requests'),
}));
vi.mock('@/modules/proxy-gateway/traffic-monitor/TrafficDetailDialog', () => ({
  TrafficDetailDialog: () => null,
}));
const clients: QueryClient[] = [];
beforeEach(() => {
  mocks.read.mockReset();
  vi.stubGlobal('electron', { onTrafficAuditEvent: () => () => undefined });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(client);
  render(createElement(QueryClientProvider, { client }, createElement(TrafficMonitorPage)));
  return client;
}
it('distinguishes a failed initial read from an empty list and offers a working retry', async () => {
  mocks.read
    .mockRejectedValueOnce(new Error('Synthetic read failure'))
    .mockResolvedValue({ items: [], total: 0 });
  mount();
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('traffic.load-failed');
  expect(screen.queryByText('Previously loaded requests')).toBeNull();
  expect(screen.queryByText('traffic.no-records')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'action.retry' }));
  await screen.findByText('Previously loaded requests');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(mocks.read).toHaveBeenCalledTimes(2);
});
it('keeps cached requests visible after a failed refresh and clears the warning after retry', async () => {
  mocks.read.mockResolvedValue({ items: [], total: 1 });
  const client = mount();
  await screen.findByText('Previously loaded requests');
  await waitFor(() => expect(client.isFetching()).toBe(0));
  mocks.read.mockRejectedValueOnce(new Error('Synthetic refresh failure'));
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['gateway', 'traffic-list'] });
  });
  expect((await screen.findByRole('alert')).textContent).toContain('traffic.refresh-failed');
  expect(screen.getByText('Previously loaded requests')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'action.retry' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(screen.getByText('Previously loaded requests')).toBeTruthy();
});
