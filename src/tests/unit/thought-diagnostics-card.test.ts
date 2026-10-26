import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProxyConfig } from '@/modules/config/types';

const mocks = vi.hoisted(() => ({
  panelMounted: vi.fn(),
  thoughtStats: vi.fn(async () => ({ sessions: 0, databaseBytes: 0, writeFailures: 0 })),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/ipc/manager', () => ({
  ipc: {
    client: {
      gateway: {
        auditStats: () =>
          Promise.resolve({
            rows: 0,
            databaseBytes: 0,
            archives: { status: 'complete' as const, bytes: 0, files: 0 },
            droppedCount: 0,
          }),
        thoughtStats: mocks.thoughtStats,
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
    capture_successful_probes: false,
    max_disk_mib: 1024,
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
    max_disk_mib: 1024,
  },
};

describe('reasoning diagnostics entry', () => {
  afterEach(() => {
    cleanup();
    mocks.panelMounted.mockReset();
    mocks.thoughtStats
      .mockReset()
      .mockResolvedValue({ sessions: 0, databaseBytes: 0, writeFailures: 0 });
  });

  it('keeps saved reasoning hidden and unmounted until explicitly expanded', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(AuditAndThoughtStoreCard, {
          config,
          onChange: vi.fn().mockResolvedValue('applied'),
        }),
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

  it('commits independent L1 and disk controls as field-only thought patches', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onChange = vi.fn().mockResolvedValue('applied');
    render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AuditAndThoughtStoreCard, { config, onChange }),
      ),
    );
    const turns = screen.getByRole('spinbutton', { name: 'proxy.persistence.thought-cache-turns' });
    fireEvent.change(turns, { target: { value: '700' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(turns);
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledExactlyOnceWith({
        thought_store: { max_turns_per_session: 700 },
      }),
    );
    await waitFor(() => expect(screen.getByText('proxy.persistence.save-applied')).toBeTruthy());
    const disk = screen.getByRole('spinbutton', { name: 'proxy.persistence.thought-disk-mib' });
    fireEvent.change(disk, { target: { value: '2048' } });
    fireEvent.blur(disk);
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith({ thought_store: { max_disk_mib: 2048 } }),
    );
    client.clear();
  });

  it('shows failed statistics as unavailable and supports deliberate refresh instead of displaying zero', async () => {
    mocks.thoughtStats.mockRejectedValueOnce(new Error('synthetic private path'));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AuditAndThoughtStoreCard, {
          config,
          onChange: vi.fn().mockResolvedValue('applied'),
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'traffic.refresh' })).toBeTruthy(),
    );
    expect(screen.queryByText('proxy.persistence.sessions')).toBeNull();
    expect(screen.queryByText('synthetic private path')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'traffic.refresh' }));
    await waitFor(() => expect(screen.getByText('proxy.persistence.sessions')).toBeTruthy());
    client.clear();
  });

  it('offers capacity controls without audit age controls and preserves Thought Store settings', () => {
    const onChange = vi.fn().mockResolvedValue('applied');
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(AuditAndThoughtStoreCard, { config, onChange }),
      ),
    );
    expect(screen.getByText('proxy.persistence.capacity-window')).toBeTruthy();
    expect(screen.queryByText('proxy.persistence.body-hours')).toBeNull();
    expect(screen.queryByText('proxy.persistence.summary-days')).toBeNull();
    expect(screen.getByText('proxy.persistence.retention-days')).toBeTruthy();
    const capacity = screen.getByRole('spinbutton', { name: 'proxy.persistence.disk-gib' });
    fireEvent.change(capacity, { target: { value: '2' } });
    fireEvent.blur(capacity);
    expect(onChange).toHaveBeenLastCalledWith({
      traffic_audit: {
        max_disk_mib: 2048,
      },
    });
  });
  it('offers an independent successful-probe opt-in and disables it with all audit capture', () => {
    const onChange = vi.fn().mockResolvedValue('applied');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const rendered = render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AuditAndThoughtStoreCard, { config, onChange }),
      ),
    );
    const toggle = screen.getByRole('switch', { name: 'proxy.persistence.successful-probes' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenLastCalledWith({
      traffic_audit: { capture_successful_probes: true },
    });
    rendered.rerender(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AuditAndThoughtStoreCard, {
          config: { ...config, traffic_audit: { ...config.traffic_audit, enabled: false } },
          onChange,
        }),
      ),
    );
    expect(toggle).toHaveProperty('disabled', true);
  });
  it('keeps numeric edits local until commit and reports the actual apply result', async () => {
    let finish!: (state: 'restart-required') => void;
    const onChange = vi.fn(
      () =>
        new Promise<'restart-required'>((resolve) => {
          finish = resolve;
        }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AuditAndThoughtStoreCard, { config, onChange }),
      ),
    );
    const input = screen.getByRole('spinbutton', { name: 'proxy.persistence.disk-gib' });
    fireEvent.change(input, { target: { value: '2' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ traffic_audit: { max_disk_mib: 2048 } });
    expect(view.container.querySelector('fieldset')?.disabled).toBe(true);
    expect(screen.getByText('proxy.persistence.save-saving')).toBeTruthy();
    await act(async () => finish('restart-required'));
    expect(screen.getByText('proxy.persistence.save-restart-required')).toBeTruthy();
    expect(screen.queryByText('proxy.persistence.save-applied')).toBeNull();
    client.clear();
  });
  it.each(['conflict', 'failed'] as const)(
    'refreshes after %s and keeps the failure visible',
    async (failure) => {
      const onChange = vi.fn(async () => {
        throw failure === 'conflict'
          ? { data: { configCode: 'conflict' } }
          : new Error('synthetic private path');
      });
      const onReload = vi.fn(async () => undefined);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(AuditAndThoughtStoreCard, { config, onChange, onReload }),
        ),
      );
      fireEvent.click(screen.getByRole('switch', { name: 'proxy.persistence.audit-title' }));
      await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
      expect(screen.getByText(`proxy.persistence.save-${failure}`).getAttribute('role')).toBe(
        'alert',
      );
      client.clear();
    },
  );
  it('blocks an owner without revision support rather than sending an unguarded edit', () => {
    const onChange = vi.fn().mockResolvedValue('applied');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AuditAndThoughtStoreCard, { config, onChange, revisionAvailable: false }),
      ),
    );
    expect(
      screen.getByRole('switch', { name: 'proxy.persistence.audit-title' }).closest('fieldset')
        ?.disabled,
    ).toBe(true);
    expect(screen.getByText('proxy.persistence.version-unavailable')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'proxy.persistence.audit-title' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole('switch', { name: 'proxy.persistence.thought-title' }).closest('fieldset')
        ?.disabled,
    ).toBe(false);
    client.clear();
  });
  it('retains the save failure and reports a failed refresh separately', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AuditAndThoughtStoreCard, {
          config,
          onChange: vi.fn().mockRejectedValue(new Error('synthetic private path')),
          onReload: vi.fn().mockRejectedValue(new Error('refresh unavailable')),
        }),
      ),
    );
    fireEvent.click(screen.getByRole('switch', { name: 'proxy.persistence.audit-title' }));
    await waitFor(() => expect(screen.getByText('proxy.persistence.reload-failed')).toBeTruthy());
    expect(screen.getByText('proxy.persistence.save-failed')).toBeTruthy();
    expect(screen.queryByText('synthetic private path')).toBeNull();
    client.clear();
  });
});
