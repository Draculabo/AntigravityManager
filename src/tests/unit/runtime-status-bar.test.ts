import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatusBar } from '@/components/layout/StatusBar';

const mocks = vi.hoisted(() => ({
  operation: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('@/modules/antigravity-runtime/actions/process', () => ({
  isProcessRunning: async () => false,
  getProcessOperation: mocks.operation,
  startAntigravity: mocks.start,
  closeAntigravity: mocks.stop,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/shared/utils/errorMessages', () => ({
  getLocalizedErrorMessage: (error: Error) => error.message,
}));
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: React.PropsWithChildren) =>
    React.createElement('div', null, children),
  DropdownMenuTrigger: ({ children }: React.PropsWithChildren) =>
    React.createElement('div', null, children),
  DropdownMenuContent: ({ children }: React.PropsWithChildren) =>
    React.createElement('div', null, children),
}));

let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.operation.mockResolvedValue('idle');
  mocks.start.mockResolvedValue(undefined);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});
afterEach(() => {
  cleanup();
  client.clear();
});

it('shows loading for a main-process switch, disables only that target, and recovers after completion', async () => {
  mocks.operation.mockImplementation(async (target) =>
    target === 'classic' ? 'switching' : 'idle',
  );
  const view = render(
    React.createElement(QueryClientProvider, { client }, React.createElement(StatusBar)),
  );
  const buttons = view.getAllByRole('button', { name: 'action.start' });
  await waitFor(() => expect(buttons[0].getAttribute('aria-busy')).toBe('true'));
  expect(buttons[0].hasAttribute('disabled')).toBe(true);
  expect(buttons[0].querySelector('svg.animate-spin')).not.toBeNull();
  await waitFor(() => expect(buttons[1].hasAttribute('disabled')).toBe(false));
  fireEvent.click(buttons[0]);
  expect(mocks.start).not.toHaveBeenCalled();
  mocks.operation.mockResolvedValue('idle');
  await client.invalidateQueries({ queryKey: ['process', 'operation'] });
  await waitFor(() => expect(buttons[0].hasAttribute('disabled')).toBe(false));
});

it('reports launch errors and clears local loading so the user can retry explicitly', async () => {
  const error = new Error('startup unconfirmed');
  mocks.start.mockRejectedValue(error);
  const view = render(
    React.createElement(QueryClientProvider, { client }, React.createElement(StatusBar)),
  );
  const button = view.getAllByRole('button', { name: 'action.start' })[0];
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
  fireEvent.click(button);
  await waitFor(() =>
    expect(mocks.toast).toHaveBeenCalledWith({
      error,
      variant: 'destructive',
      description: 'startup unconfirmed',
    }),
  );
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
  expect(mocks.start).toHaveBeenCalledExactlyOnceWith('classic');
});
