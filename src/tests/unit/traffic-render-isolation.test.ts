import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { TrafficMonitorPage } from '@/modules/proxy-gateway/traffic-monitor/TrafficMonitorPage';
import type { TrafficAuditEvent } from '@/modules/proxy-gateway/audit/traffic-audit.types';

const mocks = vi.hoisted(() => ({ tableRender: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count: number }) => (options ? `${key}:${options.count}` : key),
  }),
}));
vi.mock('@/ipc/manager', () => ({
  ipc: {
    client: {
      gateway: {
        auditList: async () => ({ items: [], total: 100 }),
        auditStats: async () => ({ rows: 100, databaseBytes: 1000, droppedCount: 0 }),
        auditFilterOptions: async () => ({ accountIds: [], modelFamilies: [] }),
      },
    },
  },
}));
vi.mock('@/modules/proxy-gateway/traffic-monitor/components/TrafficTable', () => ({
  TrafficTable: () => {
    mocks.tableRender();
    return createElement('div', null, 'Request table');
  },
}));
vi.mock('@/modules/proxy-gateway/traffic-monitor/TrafficDetailDialog', () => ({
  TrafficDetailDialog: () => null,
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  mocks.tableRender.mockClear();
});

it('isolates search, statistics and queued events while preserving submit and tab-reset behavior', async () => {
  const listeners = new Set<(event: TrafficAuditEvent) => void>();
  vi.stubGlobal('electron', {
    onTrafficAuditEvent: (listener: (event: TrafficAuditEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  const changeFilters = vi.fn();
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(TrafficMonitorPage, { initialPage: 1, onFiltersChange: changeFilters }),
    ),
  );
  await screen.findByText('traffic.records:100');
  await waitFor(() => expect(client.isFetching()).toBe(0));
  const before = mocks.tableRender.mock.calls.length;
  const input = screen.getByPlaceholderText('traffic.search-metadata');
  fireEvent.change(input, { target: { value: '  synthetic request  ' } });
  expect(changeFilters).not.toHaveBeenCalled();
  expect(mocks.tableRender).toHaveBeenCalledTimes(before);
  const form = input.closest('form');
  if (!form) {
    throw new Error('Search must be a form.');
  }
  fireEvent.submit(form);
  expect(changeFilters).toHaveBeenCalledWith(
    expect.objectContaining({ page: 0, search: 'synthetic request', tab: 'model' }),
  );
  act(() =>
    client.setQueryData(['gateway', 'audit-stats'], {
      rows: 101,
      databaseBytes: 1000,
      droppedCount: 0,
    }),
  );
  await screen.findByText('traffic.records:101');
  act(() =>
    listeners.forEach((listener) =>
      listener({ id: 'synthetic', trafficClass: 'model', kind: 'updated', timestamp: 1 }),
    ),
  );
  expect(screen.getByRole('button', { name: 'traffic.new-records:1' })).toBeTruthy();
  expect(mocks.tableRender).toHaveBeenCalledTimes(before);
  fireEvent.click(screen.getByRole('button', { name: 'traffic.model' }));
  expect(screen.queryByText(/traffic.new-records/)).toBeNull();
  expect(changeFilters).toHaveBeenLastCalledWith(
    expect.objectContaining({ page: 0, tab: 'model' }),
  );
  client.clear();
});
