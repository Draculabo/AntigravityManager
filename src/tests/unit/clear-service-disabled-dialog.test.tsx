import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ClearServiceDisabledDialog } from '@/modules/cloud-account/components/ClearServiceDisabledDialog';

const api = vi.hoisted(() => vi.fn());
vi.mock('@/ipc/manager', () => ({ ipc: { client: { cloud: { clearServiceDisabled: api } } } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('manual quarantine confirmation', () => {
  it('does not clear on open or cancel, and clears only after confirmation', async () => {
    api.mockResolvedValue(undefined);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ClearServiceDisabledDialog accountId="account-1" />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear quarantine' }));
    expect(screen.getByRole('dialog').textContent).toContain('without checking Google');
    expect(api).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear quarantine' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear local block' }));
    await waitFor(() => expect(api).toHaveBeenCalledExactlyOnceWith({ accountId: 'account-1' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
