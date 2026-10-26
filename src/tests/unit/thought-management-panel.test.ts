import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ThoughtRecordPage } from '@/modules/proxy-gateway/thought-store/thought-management.schema';

const mocks = vi.hoisted(() => ({
  sessions: vi.fn(),
  records: vi.fn(),
  detail: vi.fn(),
  remove: vi.fn(),
  clear: vi.fn(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: object) => (values ? `${key} ${JSON.stringify(values)}` : key),
  }),
}));
vi.mock('@/ipc/manager', () => ({
  ipc: {
    client: {
      gateway: {
        thoughtSessions: mocks.sessions,
        thoughtRecords: mocks.records,
        thoughtRecord: mocks.detail,
        thoughtDelete: mocks.remove,
        thoughtClear: mocks.clear,
      },
    },
  },
}));
import { ThoughtDiagnosticsPanel } from '@/modules/proxy-gateway/components/ThoughtDiagnosticsPanel';
const summary = (id: number) => ({
  id,
  model: `model-${id}`,
  createdAt: 1,
  oversized: false,
  oversizedBytes: null,
  sourceFamily: 'gemini',
  thoughtBytes: 10,
});
const page = (id = 1): ThoughtRecordPage => ({
  version: 1,
  records: [summary(id)],
  throughId: 2,
  nextCursor: id === 1 ? 1 : null,
  complete: id !== 1,
});
let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.sessions.mockResolvedValue([
    { sessionKey: 'session-one', lastAccessed: 1, bytes: 10, recordCount: 700 },
  ]);
  mocks.records.mockResolvedValue(page());
  mocks.detail.mockResolvedValue({ thought: 'saved reasoning', signature: null, oversized: false });
  mocks.remove.mockResolvedValue({ sessions: 1, records: 700 });
  mocks.clear.mockResolvedValue({ sessions: 1, records: 700 });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(createElement(QueryClientProvider, { client }, createElement(ThoughtDiagnosticsPanel)));
});
afterEach(() => {
  cleanup();
  client.clear();
});
async function selectSession() {
  fireEvent.click(await screen.findByRole('button', { name: /session-one/u }));
}

it('pages a selected session with its original high-water ID and clears the previous detail', async () => {
  await selectSession();
  fireEvent.click(await screen.findByRole('button', { name: /model-1/u }));
  expect(await screen.findByText('saved reasoning')).toBeTruthy();
  mocks.records.mockResolvedValueOnce(page(2));
  fireEvent.click(screen.getByRole('button', { name: 'proxy.persistence.next-page' }));
  expect(await screen.findByRole('button', { name: /model-2/u })).toBeTruthy();
  expect(mocks.records).toHaveBeenLastCalledWith({
    sessionKey: 'session-one',
    afterId: 1,
    throughId: 2,
    limit: 50,
  });
  expect(screen.queryByText('saved reasoning')).toBeNull();
  expect(
    screen.getByRole('button', { name: 'proxy.persistence.next-page' }).hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'proxy.persistence.previous-page' }));
  expect(await screen.findByRole('button', { name: /model-1/u })).toBeTruthy();
});

it('requires confirmation, supports cancellation and reports sessions separately from records', async () => {
  await screen.findByText('session-one');
  fireEvent.click(screen.getByRole('button', { name: 'traffic.delete-session' }));
  expect(mocks.remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'proxy.persistence.cancel-action' }));
  expect(mocks.remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'traffic.delete-session' }));
  fireEvent.click(screen.getByRole('button', { name: 'traffic.confirm-delete-session' }));
  await waitFor(() =>
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith({ sessionKey: 'session-one' }),
  );
  expect(
    await screen.findByText(
      'proxy.persistence.thought-delete-receipt {"sessions":1,"records":700}',
    ),
  ).toBeTruthy();
});

it('refreshes after an uncertain clear without retrying it and requires fresh confirmation', async () => {
  mocks.clear.mockRejectedValueOnce(new Error('private path'));
  fireEvent.click(screen.getByRole('button', { name: 'proxy.persistence.clear-thought' }));
  fireEvent.click(screen.getByRole('button', { name: 'proxy.persistence.confirm-clear' }));
  expect((await screen.findByRole('alert')).textContent).toContain(
    'proxy.persistence.thought-mutation-uncertain',
  );
  expect(screen.queryByText(/private path/u)).toBeNull();
  await waitFor(() => expect(mocks.sessions.mock.calls.length).toBeGreaterThan(1));
  expect(mocks.clear).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/thought-delete-receipt/u)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'proxy.persistence.clear-thought' }));
  expect(mocks.clear).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'proxy.persistence.cancel-action' }));
});

it('shows record-list and detail failures with deliberate retry and a missing-record state', async () => {
  mocks.records.mockRejectedValueOnce(new Error('unavailable'));
  await selectSession();
  expect(await screen.findByRole('alert')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'proxy.persistence.refresh' }));
  mocks.detail.mockRejectedValueOnce(new Error('unavailable'));
  fireEvent.click(await screen.findByRole('button', { name: /model-1/u }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  mocks.detail.mockResolvedValueOnce(null);
  fireEvent.click(screen.getByRole('button', { name: 'proxy.persistence.refresh' }));
  expect(await screen.findByText('proxy.persistence.record-unavailable')).toBeTruthy();
});

it('shows an empty page explicitly', async () => {
  mocks.records.mockResolvedValueOnce({
    version: 1,
    records: [],
    throughId: 0,
    nextCursor: null,
    complete: true,
  });
  await selectSession();
  expect(await screen.findByText('proxy.persistence.no-thought-records')).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'proxy.persistence.next-page' }).hasAttribute('disabled'),
  ).toBe(true);
});

it('keeps durable Thought counts visible while reporting incomplete recovery cleanup', async () => {
  mocks.clear.mockResolvedValueOnce({
    sessions: 1,
    records: 700,
    recoveryComplete: false,
    recovery: [{ owner: 'responses', state: 'failed', removed: 0, unknown: 0 }],
  });
  fireEvent.click(screen.getByRole('button', { name: 'proxy.persistence.clear-thought' }));
  fireEvent.click(screen.getByRole('button', { name: 'proxy.persistence.confirm-clear' }));
  expect(
    await screen.findByText(
      'proxy.persistence.thought-delete-receipt {"sessions":1,"records":700}',
    ),
  ).toBeTruthy();
  expect((await screen.findByRole('alert')).textContent).toContain(
    'proxy.persistence.thought-recovery-partial',
  );
  expect(mocks.clear).toHaveBeenCalledOnce();
});
