import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TrafficMonitorPage } from '@/modules/proxy-gateway/traffic-monitor/TrafficMonitorPage';
import { TrafficActivityHeatmap } from '@/modules/proxy-gateway/traffic-monitor/components/TrafficActivityHeatmap';
import { TrafficUsageWorkspace } from '@/modules/proxy-gateway/traffic-monitor/components/TrafficUsageWorkspace';
import type {
  UsageOverviewInput,
  UsageOverviewResult,
} from '@/modules/proxy-gateway/audit/usage-overview.schema';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  activity: vi.fn(),
  overview: vi.fn<(input: UsageOverviewInput) => Promise<UsageOverviewResult>>(),
  accounts: [
    {
      id: 'private-account-id',
      email: 'developer@example.test',
      provider: 'google' as const,
      created_at: 1,
      last_used: 1,
      proxy_configured: false,
    },
  ],
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en-US' },
    t: (key: string, options?: { formatted?: string }) =>
      options?.formatted === undefined ? key : `${key} ${options.formatted}`,
  }),
}));
vi.mock('@/ipc/manager', () => ({
  ipc: {
    client: {
      gateway: {
        auditList: mocks.read,
        auditUsageActivity: mocks.activity,
        auditUsageOverview: mocks.overview,
        auditStats: async () => ({
          rows: 1,
          databaseBytes: 1000,
          archives: { status: 'complete' as const, bytes: 0, files: 0 },
          droppedCount: 0,
        }),
        auditFilterOptions: async () => ({ accountIds: ['private-account-id'], modelFamilies: [] }),
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
vi.mock('@/modules/cloud-account/hooks/useCloudAccounts', () => ({
  useCloudAccounts: () => ({ data: mocks.accounts }),
}));
const clients: QueryClient[] = [];
beforeEach(() => {
  mocks.read.mockReset();
  mocks.activity.mockReset().mockResolvedValue([]);
  mocks.overview.mockReset();
  vi.stubGlobal('electron', { onTrafficAuditEvent: () => () => undefined });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
});
function mount(initialAccountId?: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(client);
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(TrafficMonitorPage, { initialAccountId }),
    ),
  );
  return client;
}

it('explains missing model records and exposes all saved history and unfiltered requests', async () => {
  mocks.overview.mockImplementation(async ({ from, to }) => {
    const ranked = { rows: [], truncated: false };
    return {
      from,
      to,
      bucketMs: 86_400_000,
      buckets: [],
      models: ranked,
      accounts: ranked,
      sessions: ranked,
      totals: {
        requests: 0,
        attempts: 0,
        retriedRequests: 0,
        failedRequests: 0,
        incompleteRequests: 0,
        inputTokens: 0,
        peakInputTokens: null,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheInputTokens: 0,
        cacheMeasuredAttempts: 0,
        reasoningTokens: 0,
        reasoningMeasuredAttempts: 0,
      },
    };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const openRequestHistory = vi.fn();
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(TrafficUsageWorkspace, {
        view: 'sessions',
        openRequests: vi.fn(),
        openRequestHistory,
      }),
    ),
  );
  expect(
    screen.getByRole('button', { name: 'traffic.usage-period-week' }).getAttribute('aria-pressed'),
  ).toBe('true');
  expect(screen.getByText('traffic.usage-sessions-intro')).toBeTruthy();
  expect(
    await screen.findByRole('heading', { name: 'traffic.usage-no-saved-model-requests' }),
  ).toBeTruthy();
  expect(screen.queryByLabelText('traffic.native-usage-files')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'traffic.usage-open-request-history' }));
  expect(openRequestHistory).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'traffic.usage-show-all-history' }));
  await waitFor(() =>
    expect(mocks.overview).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: 0, allRetained: true }),
    ),
  );
});

it('opens Overview grouped by actual model and keeps the other groups selectable', async () => {
  const totals = {
    requests: 1,
    attempts: 1,
    retriedRequests: 0,
    failedRequests: 0,
    incompleteRequests: 0,
    inputTokens: 5,
    peakInputTokens: 5,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheInputTokens: 0,
    cacheMeasuredAttempts: 0,
    reasoningTokens: 0,
    reasoningMeasuredAttempts: 0,
    estimatedCostUsd: 0.001,
    pricedAttempts: 1,
  };
  const ranked = { rows: [], truncated: false };
  mocks.overview.mockImplementation(async ({ from, to, seriesGroup }) => ({
    from,
    to,
    bucketMs: 86_400_000,
    buckets: [{ ...totals, timestamp: from }],
    totals,
    models: ranked,
    accounts: ranked,
    sessions: ranked,
    series: [
      {
        key: seriesGroup === 'models' ? 'synthetic-model' : 'synthetic-account',
        points: [{ timestamp: from, requests: 1, inputTokens: 5, outputTokens: 2 }],
      },
    ],
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(TrafficUsageWorkspace, {
        view: 'overview',
        openRequests: vi.fn(),
        openRequestHistory: vi.fn(),
      }),
    ),
  );
  const group = await screen.findByRole<HTMLSelectElement>('combobox', {
    name: 'traffic.usage-group-series',
  });
  expect(group.value).toBe('models');
  expect(Array.from(group.options, (option) => option.value)).toEqual([
    'models',
    'accounts',
    'clients',
    'protocols',
  ]);
  expect(screen.getByText('synthetic-model')).toBeTruthy();
  const apiCost = screen.getByText('traffic.usage-api-cost').parentElement;
  expect(apiCost?.textContent).toContain('$0.001');
  expect(apiCost?.textContent).toContain('traffic.usage-estimate-coverage');
  expect(mocks.overview).toHaveBeenLastCalledWith(
    expect.objectContaining({ seriesGroup: 'models', prices: [] }),
  );
  expect(screen.queryByRole('button', { name: 'traffic.usage-prices' })).toBeNull();
  fireEvent.change(group, { target: { value: 'accounts' } });
  expect(await screen.findByText('synthetic-account')).toBeTruthy();
  expect(mocks.overview).toHaveBeenLastCalledWith(
    expect.objectContaining({ seriesGroup: 'accounts' }),
  );
});

it.each(['sessions', 'context'] as const)(
  'shows saved titles in %s and drills into the exact stored key',
  async (view) => {
    const storeKey = `session:store:v2:0123456789ab${'c'.repeat(52)}`;
    const affinityKey = `session:affinity:v1:abcdef012345${'6'.repeat(52)}`;
    const sessionTitle = '分析桌面端布线与预览链路';
    const metrics = {
      requests: 1,
      attempts: 1,
      retriedRequests: 0,
      failedRequests: 0,
      incompleteRequests: 0,
      inputTokens: 5,
      peakInputTokens: 5,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheInputTokens: 0,
      cacheMeasuredAttempts: 0,
      reasoningTokens: 0,
      reasoningMeasuredAttempts: 0,
    };
    mocks.overview.mockImplementation(async ({ from, to }) => ({
      from,
      to,
      bucketMs: 86_400_000,
      buckets: [],
      totals: metrics,
      models: { rows: [], truncated: false },
      accounts: { rows: [], truncated: false },
      sessions: {
        rows: [
          { ...metrics, key: storeKey, client: 'codex', title: sessionTitle },
          { ...metrics, key: affinityKey },
          { ...metrics, key: 'older-session' },
        ],
        truncated: false,
      },
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    const openRequests = vi.fn();
    const { container } = render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TrafficUsageWorkspace, {
          view,
          openRequests,
          openRequestHistory: vi.fn(),
        }),
      ),
    );

    const named = await screen.findByRole('button', { name: sessionTitle });
    expect(mocks.overview).toHaveBeenCalledWith(expect.objectContaining({ sessionOffset: 0 }));
    expect(named.getAttribute('title')).toBe(sessionTitle);
    expect(screen.getByText('Codex · 0123456789ab').getAttribute('title')).toBe(storeKey);
    expect(
      screen.getAllByRole('button', { name: 'traffic.usage-session-title-unavailable' }),
    ).toHaveLength(2);
    expect(screen.getByText('traffic.usage-session-label abcdef012345')).toBeTruthy();
    expect(screen.getByText('older-session')).toBeTruthy();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    if (view === 'sessions') {
      const search = screen.getByRole('searchbox', { name: 'traffic.usage-search-sessions' });
      fireEvent.change(search, { target: { value: '  预览链路  ' } });
      fireEvent.click(screen.getByRole('button', { name: 'traffic.usage-find' }));
      await waitFor(() =>
        expect(mocks.overview).toHaveBeenLastCalledWith(
          expect.objectContaining({ sessionSearch: '预览链路', sessionOffset: 0 }),
        ),
      );
    }
    fireEvent.click(await screen.findByRole('button', { name: sessionTitle }));
    expect(openRequests).toHaveBeenCalledWith(expect.objectContaining({ sessionId: storeKey }));
    mocks.read.mockResolvedValue({ items: [], total: 0 });
    fireEvent.click(screen.getAllByRole('button', { name: 'traffic.usage-inspect-session' })[0]);
    const inspector = screen.getByRole('region', { name: 'traffic.usage-session-inspector' });
    expect(inspector.textContent).toContain(sessionTitle);
    expect(inspector.textContent).not.toContain(storeKey);
    await waitFor(() =>
      expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({ sessionId: storeKey })),
    );
  },
);

it('keeps the 53-week heatmap beside request controls and sends the request filters', async () => {
  mocks.read.mockResolvedValue({ items: [], total: 0 });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(queryClient);
  const filters = {
    initialSearch: 'retained match',
    initialFrom: 1000,
    initialTo: 2500,
    initialAccountId: 'private-account-id',
    initialStatusMode: '4xx' as const,
  };
  const { rerender } = render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(TrafficMonitorPage, filters),
    ),
  );
  const heatmap = screen.getByRole('region', { name: 'traffic.trends.activity-title' });
  expect(heatmap.parentElement).toBe(
    screen.getByRole('button', { name: 'traffic.refresh' }).parentElement,
  );
  expect(screen.queryByText('traffic.trends.title')).toBeNull();
  expect(screen.queryByText('traffic.usage-request-insights')).toBeNull();
  await waitFor(() =>
    expect(mocks.activity).toHaveBeenLastCalledWith(
      {
        filters: {
          search: 'retained match',
          from: 1000,
          to: 2500,
          accountId: 'private-account-id',
          statusMode: '4xx',
        },
      },
      expect.anything(),
    ),
  );
  rerender(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(TrafficMonitorPage, { ...filters, initialSearch: 'another match' }),
    ),
  );
  await waitFor(() =>
    expect(mocks.activity).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: expect.objectContaining({ search: 'another match' }) }),
      expect.anything(),
    ),
  );
});

it('shows 53 weeks, switches color metrics, and opens daily details on focus', async () => {
  const days = Array.from({ length: 371 }, (_, index) => ({
    date: new Date(Date.UTC(2025, 0, 6 + index)).toISOString().slice(0, 10),
    requests: index === 370 ? 3 : index === 369 ? 10 : 0,
    attempts: index === 370 ? 3 : index === 369 ? 10 : 0,
    observedTokens: index === 370 ? 1000 : index === 369 ? 10 : null,
    incompleteRequests: 0,
    estimatedCostUsd: index === 370 ? 0.005 : null,
    pricedAttempts: index === 370 ? 3 : 0,
  }));
  render(createElement(TrafficActivityHeatmap, { days }));

  const cells = screen.getAllByRole('button', { name: /traffic\.trends\.activity-count/ });
  expect(cells).toHaveLength(371);
  const latest = cells.at(-1)!;
  const previous = cells.at(-2)!;
  expect(latest.tabIndex).toBe(0);
  expect(latest.classList.contains('bg-primary')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'traffic.trends.requests' }));
  expect(previous.classList.contains('bg-primary')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'traffic.usage-price-total' }));
  expect(latest.classList.contains('bg-primary')).toBe(true);
  expect(previous.classList.contains('border-dashed')).toBe(true);
  await act(async () => latest.focus());
  expect((await screen.findByRole('tooltip')).textContent).toContain('$0.005');
  fireEvent.keyDown(latest, { key: 'ArrowUp' });
  expect(document.activeElement).toBe(previous);
});

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

it('shows account emails and avatar fallbacks in the account filter instead of IDs', async () => {
  mocks.read.mockResolvedValue({ items: [], total: 0 });
  mount('private-account-id');
  const accountFilter = await screen.findByRole('combobox', { name: 'traffic.account' });
  expect(accountFilter.textContent).toContain('developer@example.test');
  expect(accountFilter.textContent).not.toContain('private-account-id');
  expect(screen.getByTestId('traffic-account-avatar-private-account-id').textContent).toContain(
    'D',
  );
});
