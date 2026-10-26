import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TrafficMonitorPage } from '@/modules/proxy-gateway/traffic-monitor/TrafficMonitorPage';

const mocks = vi.hoisted(() => ({ clear: vi.fn(), read: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { count?: number; category?: string }) =>
      values ? `${key}:${values.category ?? ''}:${values.count ?? ''}` : key,
  }),
}));
vi.mock('@/ipc/manager', () => ({
  ipc: {
    client: {
      gateway: {
        auditList: mocks.read,
        auditClear: mocks.clear,
        auditStats: async () => ({
          rows: 1,
          databaseBytes: 0,
          archives: { status: 'complete', bytes: 0, files: 0 },
          droppedCount: 0,
        }),
        auditFilterOptions: async () => ({ accountIds: [], modelFamilies: [] }),
      },
    },
  },
}));
vi.mock('@/modules/proxy-gateway/traffic-monitor/components/TrafficTable', () => ({
  TrafficTable: () => null,
}));
vi.mock('@/modules/proxy-gateway/traffic-monitor/TrafficDetailDialog', () => ({
  TrafficDetailDialog: () => null,
}));
const clients: QueryClient[] = [];
beforeEach(() => {
  mocks.clear.mockReset();
  mocks.read.mockReset().mockResolvedValue({ items: [], total: 1 });
  vi.stubGlobal('electron', { onTrafficAuditEvent: () => () => undefined });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
});
function mount(page = 0, sessionId?: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(client);
  const change = vi.fn();
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(TrafficMonitorPage, {
        initialPage: page,
        initialSessionId: sessionId,
        initialSearch: 'filtered',
        onFiltersChange: change,
      }),
    ),
  );
  return { client, change };
}
it('states category-wide scope and cancels without calling the owner', async () => {
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'traffic.clear-category' }));
  expect(screen.getByText('traffic.clear-scope:traffic.model:')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'action.cancel' }));
  expect(mocks.clear).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'traffic.confirm-clear' })).toBeNull();
});
it('disables duplicate submission and keeps the actual owner count visible without a page reset', async () => {
  let finish!: (value: { affected: number }) => void;
  mocks.clear.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { change } = mount(2);
  fireEvent.click(screen.getByRole('button', { name: 'traffic.clear-category' }));
  fireEvent.click(screen.getByRole('button', { name: 'traffic.confirm-clear' }));
  expect(screen.getByRole('button', { name: 'traffic.clearing' }).hasAttribute('disabled')).toBe(
    true,
  );
  expect(mocks.clear).toHaveBeenCalledExactlyOnceWith({ trafficClass: 'model' });
  await act(async () => finish({ affected: 7 }));
  expect((await screen.findByRole('status')).textContent).toContain(
    'traffic.clear-complete:traffic.model:7',
  );
  // The current page can be refreshed safely without remounting away the receipt.
  expect(change).not.toHaveBeenCalled();
});
it('reports uncertain failure, refreshes cached data and requires a fresh confirmation', async () => {
  mocks.clear.mockRejectedValue(new Error('private synthetic owner failure'));
  const { client } = mount();
  await waitFor(() => expect(client.isFetching()).toBe(0));
  fireEvent.click(screen.getByRole('button', { name: 'traffic.clear-category' }));
  fireEvent.click(screen.getByRole('button', { name: 'traffic.confirm-clear' }));
  expect((await screen.findByRole('alert')).textContent).toBe('traffic.clear-failed');
  expect(screen.queryByRole('button', { name: 'traffic.confirm-clear' })).toBeNull();
  await waitFor(() => expect(mocks.read.mock.calls.length).toBeGreaterThan(1));
});
it('propagates exact session selection through filter navigation and sends an initial key unchanged', async () => {
  const { change, client } = mount(0, 'tenant-one:initial');
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(mocks.read).toHaveBeenLastCalledWith(
    expect.objectContaining({ sessionId: 'tenant-one:initial' }),
  );
  const input = screen.getByRole('textbox', { name: 'traffic.exact-session' });
  fireEvent.change(input, { target: { value: ' tenant-one:session_% ' } });
  expect(change).not.toHaveBeenCalled();
  fireEvent.submit(input.closest('form')!);
  expect(change).toHaveBeenLastCalledWith(
    expect.objectContaining({ page: 0, sessionId: 'tenant-one:session_%' }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'traffic.reset-session' }));
  expect(change).toHaveBeenLastCalledWith(
    expect.objectContaining({ page: 0, sessionId: undefined }),
  );
});
