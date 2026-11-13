// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { ORPCError } from '@orpc/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountProjectIdDialog } from '@/modules/cloud-account/components/CloudAccountProjectIdDialog';

const actions = vi.hoisted(() => ({
  getAccountProjectId: vi.fn(),
  setAccountProjectId: vi.fn(),
  fetchAccountProjectId: vi.fn(),
}));

vi.mock('@/modules/cloud-account/actions/cloud', () => actions);
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

function openDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CloudAccountProjectIdDialog accountId="google-account" email="account@example.com" />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'cloud.project-id.title' }));
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('Google account Project ID editor', () => {
  it('reads on open and saves and clears with the displayed saved value as the precondition', async () => {
    actions.getAccountProjectId
      .mockResolvedValueOnce({ projectId: 'original-id' })
      .mockResolvedValueOnce({ projectId: 'edited-id' })
      .mockResolvedValueOnce({ projectId: null });
    actions.setAccountProjectId
      .mockResolvedValueOnce({ projectId: 'edited-id' })
      .mockResolvedValueOnce({ projectId: null });
    openDialog();

    const input = await screen.findByRole('textbox', { name: 'cloud.project-id.title' });
    expect(input).toHaveValue('original-id');
    fireEvent.change(input, { target: { value: ' edited-id ' } });
    fireEvent.click(screen.getByRole('button', { name: 'cloud.project-id.save' }));
    await waitFor(() => expect(input).toHaveValue('edited-id'));
    expect(actions.setAccountProjectId).toHaveBeenNthCalledWith(1, {
      accountId: 'google-account',
      expectedProjectId: 'original-id',
      projectId: 'edited-id',
    });

    fireEvent.click(screen.getByRole('button', { name: 'cloud.project-id.clear' }));
    await waitFor(() => expect(input).toHaveValue(''));
    expect(actions.setAccountProjectId).toHaveBeenNthCalledWith(2, {
      accountId: 'google-account',
      expectedProjectId: 'edited-id',
      projectId: null,
    });
  });

  it('keeps the saved value on a failed provider fetch and displays a successful replacement', async () => {
    actions.getAccountProjectId
      .mockResolvedValueOnce({ projectId: 'original-id' })
      .mockResolvedValueOnce({ projectId: 'original-id' })
      .mockResolvedValueOnce({ projectId: 'fetched-id' });
    actions.fetchAccountProjectId
      .mockRejectedValueOnce(new ORPCError('BAD_GATEWAY'))
      .mockResolvedValueOnce({ projectId: 'fetched-id' });
    openDialog();

    const input = await screen.findByRole('textbox', { name: 'cloud.project-id.title' });
    const fetch = screen.getByRole('button', { name: 'cloud.project-id.fetch' });
    fireEvent.click(fetch);
    expect(await screen.findByRole('alert')).toHaveTextContent('cloud.project-id.fetch-failed');
    expect(input).toHaveValue('original-id');
    expect(actions.fetchAccountProjectId).toHaveBeenCalledWith({
      accountId: 'google-account',
      expectedProjectId: 'original-id',
    });

    fireEvent.click(fetch);
    await waitFor(() => expect(input).toHaveValue('fetched-id'));
  });

  it('reloads the latest value after a conflict without retrying the stale edit', async () => {
    actions.getAccountProjectId
      .mockResolvedValueOnce({ projectId: 'original-id' })
      .mockResolvedValueOnce({ projectId: 'concurrent-id' });
    actions.setAccountProjectId.mockRejectedValueOnce(new ORPCError('CONFLICT'));
    openDialog();

    const input = await screen.findByRole('textbox', { name: 'cloud.project-id.title' });
    fireEvent.change(input, { target: { value: 'stale-id' } });
    fireEvent.click(screen.getByRole('button', { name: 'cloud.project-id.save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('cloud.project-id.conflict');
    expect(input).toHaveValue('concurrent-id');
    expect(actions.setAccountProjectId).toHaveBeenCalledTimes(1);
  });
});
