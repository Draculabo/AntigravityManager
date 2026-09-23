import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProxyConfig } from '@/modules/config/types';

const mocks = vi.hoisted(() => ({ panelMounted: vi.fn() }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/ipc/manager', () => ({
  ipc: {
    client: {
      gateway: {
        auditStats: () => Promise.resolve({ rows: 0, databaseBytes: 0, droppedCount: 0 }),
        thoughtStats: () => Promise.resolve({ sessions: 0, databaseBytes: 0 }),
      },
    },
  },
}));
vi.mock('@/modules/proxy-gateway/components/ThoughtDiagnosticsPanel', () => ({
  ThoughtDiagnosticsPanel: () => {
    mocks.panelMounted();
    return createElement('div', { 'data-testid': 'thought-diagnostics' });
  },
}));

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

describe('reasoning diagnostics entry', () => {
  afterEach(() => {
    cleanup();
    mocks.panelMounted.mockReset();
  });

  it('keeps saved reasoning hidden and unmounted until explicitly expanded', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(AuditAndThoughtStoreCard, { config, onChange: vi.fn() }),
      ),
    );

    const toggle = screen.getByRole('button', { name: 'traffic.advanced-diagnostics' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('thought-diagnostics')).toBeNull();
    expect(mocks.panelMounted).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('thought-diagnostics')).toBeTruthy();
    expect(mocks.panelMounted).toHaveBeenCalledOnce();
  });
});
