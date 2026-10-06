import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { TrafficRefreshControls } from '@/modules/proxy-gateway/traffic-monitor/components/TrafficRefreshControls';
import type { TrafficAuditEvent } from '@/modules/proxy-gateway/audit/traffic-audit.types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count: number }) => (options ? `${key}:${options.count}` : key),
  }),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup(page: number, selectedId: string | null = null) {
  const listeners = new Set<(event: TrafficAuditEvent) => void>();
  vi.stubGlobal('electron', {
    onTrafficAuditEvent: (listener: (event: TrafficAuditEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
  const view = render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(TrafficRefreshControls, { tab: 'model', page, selectedId }),
    ),
  );
  const emit = (id: string, trafficClass: TrafficAuditEvent['trafficClass'] = 'model') =>
    act(() => {
      listeners.forEach((listener) =>
        listener({ id, kind: 'updated', timestamp: 1, trafficClass }),
      );
    });
  return { emit, invalidate, listeners, view, client };
}

it('buffers matching notifications on older pages and clears the count on refresh', async () => {
  const { emit, invalidate, listeners, view, client } = setup(1);
  emit('ignored', 'ipc');
  expect(screen.queryByText(/traffic.new-records/)).toBeNull();
  emit('first');
  emit('second');
  expect(screen.getByRole('button', { name: 'traffic.new-records:2' })).toBeTruthy();
  expect(invalidate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'traffic.refresh' }));
  await waitFor(() => expect(screen.queryByText(/traffic.new-records/)).toBeNull());
  expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: ['gateway'] });
  view.unmount();
  expect(listeners.size).toBe(0);
  client.clear();
});

it('refreshes the visible list immediately on the first page', () => {
  const { emit, invalidate, client } = setup(0);
  emit('first');
  expect(invalidate).toHaveBeenCalledExactlyOnceWith({
    queryKey: ['gateway', 'traffic-list', 'model'],
  });
  expect(screen.queryByText(/traffic.new-records/)).toBeNull();
  client.clear();
});

it('keeps the list paused while a detail dialog is open and refreshes its matching detail', () => {
  const { emit, invalidate, client } = setup(0, 'selected');
  emit('other');
  expect(invalidate).not.toHaveBeenCalled();
  emit('selected');
  expect(invalidate).toHaveBeenCalledExactlyOnceWith({
    queryKey: ['gateway', 'traffic-detail', 'selected'],
  });
  expect(screen.getByRole('button', { name: 'traffic.new-records:2' })).toBeTruthy();
  client.clear();
});
