import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountLoginDialog } from '@/modules/cloud-account/components/CloudAccountLoginDialog';
import { CloudAccountFileDialogs } from '@/modules/cloud-account/components/CloudAccountFileDialogs';

const actions = vi.hoisted(() => ({
  listOAuthClients: vi.fn(),
  startAuthFlow: vi.fn(),
  submitAuthCode: vi.fn(),
  setActiveOAuthClient: vi.fn(),
  exportCloudAccounts: vi.fn(),
  importCloudAccounts: vi.fn(),
  toast: vi.fn(),
  parentRender: vi.fn(),
  siblingRender: vi.fn(),
}));
vi.mock('@/modules/cloud-account/actions/cloud', () => actions);
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: actions.toast }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const clients: QueryClient[] = [];
beforeEach(() => {
  actions.listOAuthClients.mockResolvedValue([
    { key: 'active-client', label: 'Active client', is_active: true },
  ]);
  actions.submitAuthCode.mockResolvedValue(undefined);
  actions.setActiveOAuthClient.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.resetAllMocks();
});

function renderDialogs() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(queryClient);
  function AccountGridSibling() {
    actions.siblingRender();
    return createElement('div', null, 'Account grid');
  }
  function Page() {
    actions.parentRender();
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(CloudAccountLoginDialog),
      createElement(CloudAccountFileDialogs),
      createElement(AccountGridSibling),
    );
  }
  render(createElement(Page));
  return queryClient;
}

describe('account dialog state ownership', () => {
  it('keeps typing and browser login updates out of the parent and sibling grid', async () => {
    const login = Promise.withResolvers<void>();
    actions.startAuthFlow.mockReturnValue(login.promise);
    renderDialogs();
    fireEvent.click(screen.getByRole('button', { name: 'cloud.addAccount' }));
    const openLogin = screen.getByRole('button', { name: 'cloud.authDialog.openLogin' });
    await waitFor(() => expect((openLogin as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(openLogin);
    await waitFor(() =>
      expect(actions.startAuthFlow).toHaveBeenCalledExactlyOnceWith(
        { oauthClientKey: 'active-client' },
        expect.anything(),
      ),
    );
    const input = screen.getByLabelText('cloud.authDialog.authCode');
    fireEvent.change(input, { target: { value: '  4/synthetic-code  ' } });
    const verify = screen.getByRole('button', { name: 'cloud.authDialog.verify' });
    await waitFor(() => expect((verify as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(verify);
    await waitFor(() =>
      expect(actions.submitAuthCode).toHaveBeenCalledExactlyOnceWith(
        { code: '4/synthetic-code' },
        expect.anything(),
      ),
    );
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(''));
    await act(async () => login.resolve());
    await waitFor(() => expect(screen.queryByLabelText('cloud.authDialog.authCode')).toBeNull());
    expect(actions.toast).toHaveBeenCalledWith({
      title: 'cloud.toast.addSuccess',
      variant: 'success',
    });
    expect(actions.parentRender).toHaveBeenCalledOnce();
    expect(actions.siblingRender).toHaveBeenCalledOnce();
  });

  it('clears a pasted code when closing the login dialog', async () => {
    renderDialogs();
    fireEvent.click(screen.getByRole('button', { name: 'cloud.addAccount' }));
    fireEvent.change(screen.getByLabelText('cloud.authDialog.authCode'), {
      target: { value: 'synthetic-code' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'common.close' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'cloud.addAccount' }));
    expect((screen.getByLabelText('cloud.authDialog.authCode') as HTMLInputElement).value).toBe('');
    expect(
      (screen.getByRole('button', { name: 'cloud.authDialog.verify' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('retains the export dialog on cancellation and preserves both export options', async () => {
    actions.exportCloudAccounts
      .mockResolvedValueOnce({ status: 'cancelled' })
      .mockResolvedValueOnce({ status: 'saved' });
    renderDialogs();
    fireEvent.click(screen.getByRole('button', { name: 'cloud.exportImport.export' }));
    fireEvent.click(screen.getByRole('button', { name: 'cloud.exportImport.includeTokens' }));
    await waitFor(() =>
      expect(actions.exportCloudAccounts).toHaveBeenCalledWith(
        { stripTokens: false },
        expect.anything(),
      ),
    );
    const strip = screen.getByRole('button', { name: 'cloud.exportImport.stripTokens' });
    await waitFor(() => expect((strip as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(strip);
    await waitFor(() => expect(screen.queryByText('cloud.exportImport.exportTitle')).toBeNull());
    expect(actions.exportCloudAccounts).toHaveBeenLastCalledWith(
      { stripTokens: true },
      expect.anything(),
    );
    expect(actions.toast).toHaveBeenCalledWith({ title: 'cloud.exportImport.exportSuccess' });
    expect(actions.siblingRender).toHaveBeenCalledOnce();
  });

  it('imports through the existing query mutation and reports partial failures', async () => {
    const summary = {
      status: 'imported',
      imported: 1,
      updated: 0,
      skipped: 0,
      failed: 1,
      errors: [{ email: 'test@example.com', code: 'tokens-missing' }],
    };
    actions.importCloudAccounts.mockResolvedValue(summary);
    const client = renderDialogs();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(screen.getByRole('button', { name: 'cloud.exportImport.import' }));
    const buttons = screen.getAllByRole('button', { name: 'cloud.exportImport.import' });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(screen.queryByText('cloud.exportImport.importTitle')).toBeNull());
    expect(actions.importCloudAccounts).toHaveBeenCalledWith(
      { strategy: 'merge' },
      expect.anything(),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['cloudAccounts'] });
    expect(actions.toast).toHaveBeenCalledWith({ title: 'cloud.exportImport.importSuccess' });
    expect(actions.toast).toHaveBeenCalledWith({
      title: 'cloud.exportImport.importErrors',
      description: 'test@example.com: cloud.exportImport.file-errors.tokens-missing',
      variant: 'destructive',
    });
  });
});
