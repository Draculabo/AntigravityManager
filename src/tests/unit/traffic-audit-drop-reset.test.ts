import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyConfig } from '@/modules/config/types';

const mocks = vi.hoisted(() => ({
  auditStats: vi.fn(),
  auditResetDropStats: vi.fn(),
  thoughtStats: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/ipc/manager', () => ({
  ipc: {
    client: {
      gateway: {
        auditStats: mocks.auditStats,
        auditResetDropStats: mocks.auditResetDropStats,
        thoughtStats: mocks.thoughtStats,
      },
    },
  },
}));

import { TrafficMonitorHeader } from '@/modules/proxy-gateway/traffic-monitor/components/TrafficMonitorHeader';
import { AuditAndThoughtStoreCard } from '@/modules/proxy-gateway/components/AuditAndThoughtStoreCard';

const config: Pick<ProxyConfig, 'thought_store' | 'traffic_audit'> = {
  traffic_audit: {
    enabled: true,
    max_disk_mib: 1024,
    body_retention_hours: 24,
    summary_retention_days: 30,
    max_rows: 100_000,
    max_queue_records: 512,
    max_queue_mib: 16,
  },
  thought_store: {
    enabled: true,
    retention_days: 15,
    max_sessions: 2000,
    max_turns_per_session: 200,
    max_session_mib: 64,
  },
};

describe('Traffic audit drop counter reset', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    mocks.thoughtStats.mockResolvedValue({ sessions: 0, databaseBytes: 0 });
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
  });

  it('renders reset button in TrafficMonitorHeader when drops > 0 and resets on click', async () => {
    mocks.auditStats.mockResolvedValue({
      rows: 50,
      databaseBytes: 2048,
      droppedCount: 42,
    });
    mocks.auditResetDropStats.mockResolvedValue({ affected: 1 });

    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(TrafficMonitorHeader),
      ),
    );

    const resetButton = await screen.findByRole('button', { name: 'traffic.reset-dropped' });
    expect(resetButton).toBeTruthy();

    fireEvent.click(resetButton);

    await waitFor(() => {
      expect(mocks.auditResetDropStats).toHaveBeenCalledWith({ trafficClass: null });
    });
  });

  it('hides reset button in TrafficMonitorHeader when droppedCount is 0', async () => {
    mocks.auditStats.mockResolvedValue({
      rows: 50,
      databaseBytes: 2048,
      droppedCount: 0,
    });

    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(TrafficMonitorHeader),
      ),
    );

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'traffic.reset-dropped' })).toBeNull();
    });
  });

  it('renders reset button in AuditAndThoughtStoreCard when drops > 0 and resets on click', async () => {
    mocks.auditStats.mockResolvedValue({
      rows: 10,
      databaseBytes: 4096,
      droppedCount: 15,
      lastDropReason: 'queue_capacity',
      workerPendingCommands: 0,
    });
    mocks.auditResetDropStats.mockResolvedValue({ affected: 1 });

    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(AuditAndThoughtStoreCard, { config, onChange: vi.fn() }),
      ),
    );

    const resetButton = await screen.findByRole('button', { name: 'traffic.reset-dropped' });
    expect(resetButton).toBeTruthy();

    fireEvent.click(resetButton);

    await waitFor(() => {
      expect(mocks.auditResetDropStats).toHaveBeenCalledWith({ trafficClass: null });
    });
  });

  it('hides reset button in AuditAndThoughtStoreCard when droppedCount is 0', async () => {
    mocks.auditStats.mockResolvedValue({
      rows: 10,
      databaseBytes: 4096,
      droppedCount: 0,
      workerPendingCommands: 0,
    });

    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(AuditAndThoughtStoreCard, { config, onChange: vi.fn() }),
      ),
    );

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'traffic.reset-dropped' })).toBeNull();
    });
  });
});
