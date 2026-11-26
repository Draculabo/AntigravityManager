import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountLoginDialog } from '@/modules/cloud-account/components/CloudAccountLoginDialog';
import { CloudAccountTransferMenu } from '@/modules/cloud-account/components/CloudAccountTransferMenu';

const actions = vi.hoisted(() => ({
  listOAuthClients: vi.fn(),
  prepareOAuthSession: vi.fn(),
  openOAuthSession: vi.fn(),
  copyOAuthSessionLink: vi.fn(),
  waitForOAuthSession: vi.fn(),
  submitOAuthSessionCallback: vi.fn(),
  cancelOAuthSession: vi.fn(),
  importCloudAccountRefreshToken: vi.fn(),
  setActiveOAuthClient: vi.fn(),
  exportCloudAccounts: vi.fn(),
  importCloudAccounts: vi.fn(),
  previewLocalImport: vi.fn(),
  toast: vi.fn(),
  parentRender: vi.fn(),
  siblingRender: vi.fn(),
}));
vi.mock('@/modules/cloud-account/actions/cloud', () => actions);
vi.mock('@/modules/cloud-account/local-import/hooks/useLocalAccountImport', () => ({
  useLocalAccountImport: () => ({
    preview: { mutateAsync: actions.previewLocalImport, reset: () => {} },
    confirm: { reset: () => {} },
    discard: { mutateAsync: () => Promise.resolve() },
  }),
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: actions.toast }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const clients: QueryClient[] = [];
beforeEach(() => {
  actions.listOAuthClients.mockResolvedValue([
    { key: 'active-client', label: 'Active client', is_active: true },
  ]);
  actions.prepareOAuthSession.mockResolvedValue({ sessionId: 'session-1' });
  actions.waitForOAuthSession.mockImplementation(() => new Promise(() => {}));
  actions.cancelOAuthSession.mockResolvedValue(undefined);
  actions.openOAuthSession.mockResolvedValue(undefined);
  actions.copyOAuthSessionLink.mockResolvedValue(undefined);
  actions.submitOAuthSessionCallback.mockResolvedValue(undefined);
  actions.setActiveOAuthClient.mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => cleanup());
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
      createElement(CloudAccountTransferMenu),
      createElement(AccountGridSibling),
    );
  }
  render(createElement(Page));
  return queryClient;
}

function openTransferMenu() {
  const trigger = screen.getByRole('button', { name: 'cloud.exportImport.transfer-menu' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return trigger;
}

describe('account dialog state ownership', () => {
  async function openLogin() {
    await userEvent.click(screen.getByRole('button', { name: 'cloud.addAccount' }));
    const open = await screen.findByRole<HTMLButtonElement>('button', {
      name: 'cloud.authDialog.openLogin',
    });
    await waitFor(() => expect(open.disabled).toBe(false));
    return open;
  }

  it('prepares without opening a browser and copies the prepared link', async () => {
    renderDialogs();
    await openLogin();
    expect(actions.prepareOAuthSession).toHaveBeenCalledExactlyOnceWith('active-client');
    expect(actions.openOAuthSession).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'cloud.add-flow.copy-link' }));
    expect(actions.copyOAuthSessionLink).toHaveBeenCalledExactlyOnceWith('session-1');
    expect(await screen.findByText('cloud.add-flow.link-copied')).toBeTruthy();
  });

  it('keeps a rejected callback address and submits its state unchanged on retry', async () => {
    actions.submitOAuthSessionCallback.mockRejectedValueOnce({
      data: { loginCode: 'invalid-manual-input' },
    });
    renderDialogs();
    await userEvent.click(await openLogin());
    expect(actions.openOAuthSession).toHaveBeenCalledExactlyOnceWith('session-1');
    await userEvent.click(screen.getByText('cloud.authDialog.manual-sign-in'));
    const input = screen.getByLabelText<HTMLInputElement>('cloud.add-flow.callback-label');
    const pasted = 'http://127.0.0.1:1234/oauth-callback?code=4%2Fsynthetic&state=current';
    fireEvent.change(input, { target: { value: ` ${pasted} ` } });
    const submit = screen.getByRole('button', { name: 'cloud.add-flow.submit-callback' });
    await userEvent.click(submit);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'cloud.toast.addFailed.codes.invalid-manual-input',
    );
    expect(input.value).toBe(` ${pasted} `);
    expect(actions.submitOAuthSessionCallback).toHaveBeenCalledExactlyOnceWith('session-1', pasted);
    await userEvent.click(submit);
    await waitFor(() => expect(input.value).toBe(''));
    expect(actions.submitOAuthSessionCallback).toHaveBeenCalledTimes(2);
  });

  it('updates the account list after browser authorization without re-rendering the grid', async () => {
    const login = Promise.withResolvers<void>();
    actions.waitForOAuthSession.mockReturnValueOnce(login.promise);
    const client = renderDialogs();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await userEvent.click(await openLogin());
    await act(async () => login.resolve());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['cloudAccounts'] });
    expect(actions.toast).toHaveBeenCalledWith({
      title: 'cloud.toast.addSuccess',
      variant: 'success',
    });
    expect(actions.parentRender).toHaveBeenCalledOnce();
    expect(actions.siblingRender).toHaveBeenCalledOnce();
  });

  it('cancels when leaving the authorization tab and clears the callback on return', async () => {
    renderDialogs();
    await openLogin();
    await userEvent.click(screen.getByText('cloud.authDialog.manual-sign-in'));
    fireEvent.change(screen.getByLabelText('cloud.add-flow.callback-label'), {
      target: { value: 'synthetic-code' },
    });
    await userEvent.click(screen.getByRole('tab', { name: 'cloud.add-flow.tabs.local' }));
    await waitFor(() => expect(actions.cancelOAuthSession).toHaveBeenCalledWith('session-1'));
    expect(screen.queryByLabelText('cloud.add-flow.callback-label')).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: 'cloud.add-flow.tabs.google' }));
    await userEvent.click(screen.getByText('cloud.authDialog.manual-sign-in'));
    expect(screen.getByLabelText<HTMLInputElement>('cloud.add-flow.callback-label').value).toBe('');
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'cloud.add-flow.submit-callback' })
        .disabled,
    ).toBe(true);
  });

  it('de-duplicates pasted credentials and retries only failed rows', async () => {
    actions.importCloudAccountRefreshToken
      .mockResolvedValueOnce({ status: 'added', email: 'first@example.test' })
      .mockResolvedValueOnce({ status: 'failed', reason: 'verification-failed' })
      .mockResolvedValueOnce({ status: 'added', email: 'retry@example.test' });
    const client = renderDialogs();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await openLogin();
    await userEvent.click(screen.getByRole('tab', { name: 'cloud.add-flow.tabs.credentials' }));
    const input = screen.getByLabelText<HTMLTextAreaElement>('cloud.add-flow.credentials.label');
    const first = 'synthetic-refresh-first';
    const second = 'synthetic-refresh-second';
    fireEvent.change(input, { target: { value: [first, second, first].join('\n') } });
    await userEvent.click(
      screen.getByRole('button', { name: 'cloud.add-flow.credentials.import' }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'cloud.add-flow.credentials.retry' }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('button', {
          name: 'cloud.add-flow.credentials.retry',
        }),
      ).toBeNull(),
    );
    expect(actions.importCloudAccountRefreshToken.mock.calls).toEqual([
      [first],
      [second],
      [second],
    ]);
    expect(input.value).toBe('');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['cloudAccounts'] });
  });

  it('retains the export dialog on cancellation and preserves both export options', async () => {
    actions.exportCloudAccounts
      .mockResolvedValueOnce({ status: 'cancelled' })
      .mockResolvedValueOnce({ status: 'saved' });
    renderDialogs();
    const trigger = openTransferMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'cloud.exportImport.exportTitle' }));
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
    await waitFor(() => expect(document.activeElement).toBe(trigger));
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
    openTransferMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'cloud.exportImport.import-from-file' }));
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

  it('opens local discovery from the keyboard and restores focus after closing it', async () => {
    actions.previewLocalImport.mockReturnValue(new Promise(() => {}));
    renderDialogs();
    expect(screen.queryByRole('button', { name: 'cloud.localImport.trigger' })).toBeNull();
    const user = userEvent.setup();
    const trigger = screen.getByRole('button', { name: 'cloud.exportImport.transfer-menu' });
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    const item = await screen.findByRole('menuitem', { name: 'cloud.localImport.trigger' });
    await waitFor(() => expect(document.activeElement).toBe(item));
    await user.keyboard('{Enter}');
    await screen.findByRole('dialog', { name: 'cloud.localImport.title' });
    expect(actions.previewLocalImport).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
