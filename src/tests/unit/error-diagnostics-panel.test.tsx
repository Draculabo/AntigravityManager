import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ErrorDiagnosticsCard } from '@/modules/error-diagnostics/components/ErrorDiagnosticsCard';
import { serviceConfigPlaceholder } from '@/modules/config/settings-change';

const mocks = vi.hoisted(() => ({
  sources: vi.fn(),
  query: vi.fn(),
  preview: vi.fn(),
  save: vi.fn(),
  discard: vi.fn(),
  clear: vi.fn(),
  update: vi.fn(),
  directory: vi.fn(),
}));
vi.mock('@/ipc/manager', () => ({
  ipc: {
    client: {
      errorDiagnostics: {
        sources: mocks.sources,
        query: mocks.query,
        preview: mocks.preview,
        save: mocks.save,
        discard: mocks.discard,
        clear: mocks.clear,
        openDirectory: mocks.directory,
      },
      config: { service: { update: mocks.update } },
    },
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: object) => (values ? `${key} ${JSON.stringify(values)}` : key),
  }),
}));
const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const capability = '33333333-3333-4333-8333-333333333333';
const generation = '44444444-4444-4444-8444-444444444444';
const row = (id: string, sequence: number) => ({
  id,
  sequence,
  createdAt: '2026-11-05T00:00:00Z',
  source: 'logger',
  category: 'fixture',
  requestId: null,
  attemptId: null,
  status: null,
  message: `failure-${sequence}`,
  bytes: 200,
});
let cache: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  mocks.sources.mockResolvedValue([
    { state: 'unavailable', role: 'app' },
    { state: 'unavailable', role: 'core' },
  ]);
  mocks.query.mockResolvedValue({
    generation,
    records: [row(firstId, 1)],
    throughSequence: 2,
    nextSequence: 1,
    complete: false,
  });
  mocks.preview.mockResolvedValue({
    status: 'ready',
    preview: {
      capabilityId: capability,
      role: 'app',
      id: firstId,
      text: 'retained sanitized stack',
      truncated: true,
      bytes: 100000,
    },
  });
  mocks.save.mockResolvedValue({ status: 'saved' });
  mocks.discard.mockResolvedValue(undefined);
  mocks.clear.mockResolvedValue({ generation, records: 3 });
  mocks.update.mockResolvedValue({ state: 'applied', snapshot: serviceConfigPlaceholder() });
  render(
    createElement(
      QueryClientProvider,
      { client: cache },
      createElement(ErrorDiagnosticsCard, { config: serviceConfigPlaceholder(), available: true }),
    ),
  );
});
afterEach(() => {
  cleanup();
  cache.clear();
});
async function browse() {
  fireEvent.click(screen.getByRole('button', { name: 'error-diagnostics.browse' }));
  await screen.findByRole('button', { name: /failure-1/u });
}

it('reports unavailable usage rather than zero and retries actual query failures', async () => {
  expect(await screen.findAllByText('error-diagnostics.source-unavailable')).toHaveLength(2);
  mocks.query.mockRejectedValueOnce(new Error('fixture read failure'));
  fireEvent.click(screen.getByRole('button', { name: 'error-diagnostics.browse' }));
  expect(await screen.findByText('error-diagnostics.load-failed')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'error-diagnostics.retry' }));
  expect(await screen.findByRole('button', { name: /failure-1/u })).toBeTruthy();
});

it('pages with the original high-water mark and releases the previous preview capability', async () => {
  await browse();
  fireEvent.click(screen.getByRole('button', { name: /failure-1/u }));
  expect(await screen.findByText('retained sanitized stack')).toBeTruthy();
  mocks.query.mockResolvedValueOnce({
    generation,
    records: [row(secondId, 2)],
    throughSequence: 2,
    nextSequence: null,
    complete: true,
  });
  fireEvent.click(screen.getByRole('button', { name: 'error-diagnostics.next-page' }));
  expect(await screen.findByRole('button', { name: /failure-2/u })).toBeTruthy();
  expect(mocks.query).toHaveBeenLastCalledWith({
    role: 'app',
    requestId: undefined,
    afterSequence: 1,
    throughSequence: 2,
    limit: 50,
  });
  expect(screen.queryByText('retained sanitized stack')).toBeNull();
  await waitFor(() => expect(mocks.discard).toHaveBeenCalledWith({ capabilityId: capability }));
});

it('saves the reviewed capability and never sends preview text as export input', async () => {
  await browse();
  fireEvent.click(screen.getByRole('button', { name: /failure-1/u }));
  expect(await screen.findByText('error-diagnostics.preview-truncated')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'error-diagnostics.save-complete' }));
  expect(await screen.findByText('error-diagnostics.export-saved')).toBeTruthy();
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith({ capabilityId: capability });
});

it('requires clear confirmation, permits cancellation, and preserves uncertain failure feedback', async () => {
  await browse();
  fireEvent.click(screen.getByRole('button', { name: /error-diagnostics.clear-source/u }));
  expect(mocks.clear).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'error-diagnostics.cancel' }));
  expect(mocks.clear).not.toHaveBeenCalled();
  mocks.clear.mockRejectedValueOnce(new Error('fixture uncertain clear'));
  fireEvent.click(screen.getByRole('button', { name: /error-diagnostics.clear-source/u }));
  fireEvent.click(screen.getByRole('button', { name: /error-diagnostics.confirm-clear/u }));
  expect(await screen.findByText('error-diagnostics.clear-failed')).toBeTruthy();
  expect(mocks.clear).toHaveBeenCalledExactlyOnceWith({ role: 'app' });
});

it('commits only the capacity field and reports save application independently of reclaim', async () => {
  const input = screen.getByLabelText('error-diagnostics.budget');
  fireEvent.change(input, { target: { value: '100' } });
  fireEvent.blur(input);
  expect(await screen.findByText('error-diagnostics.budget-applied')).toBeTruthy();
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
    error_diagnostics: { max_storage_mib: 100 },
  });
});
