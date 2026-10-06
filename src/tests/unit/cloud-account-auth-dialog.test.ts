// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CloudAccountAuthDialog } from '@/modules/cloud-account/components/CloudAccountAuthDialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function renderDialog(isAddPending: boolean) {
  const onAuthCodeChange = vi.fn();
  const onSubmitAuthCode = vi.fn();
  render(
    createElement(CloudAccountAuthDialog, {
      open: true,
      onOpenChange: vi.fn(),
      selectedOAuthClientKey: '',
      oauthClients: [],
      isOAuthClientsLoading: false,
      isSetActiveOAuthClientPending: false,
      isAddPending,
      isCodeSubmitting: false,
      authCode: '4/manual-code',
      onOAuthClientChange: vi.fn(),
      onOpenGoogleAuthSignIn: vi.fn(),
      onAuthCodeChange,
      onSubmitAuthCode,
    }),
  );
  return { onAuthCodeChange, onSubmitAuthCode };
}

describe('cloud account login dialog', () => {
  it('keeps the manual code field visible and submits it during a browser login', () => {
    const { onAuthCodeChange, onSubmitAuthCode } = renderDialog(true);
    const input = screen.getByLabelText('cloud.authDialog.authCode');
    expect((input as HTMLInputElement).value).toBe('4/manual-code');
    fireEvent.change(input, { target: { value: '4/new-code' } });
    expect(onAuthCodeChange).toHaveBeenCalledExactlyOnceWith('4/new-code');
    fireEvent.click(screen.getByRole('button', { name: 'cloud.authDialog.verify' }));
    expect(onSubmitAuthCode).toHaveBeenCalledOnce();
  });

  it('waits for an active browser login before accepting a pasted code', () => {
    renderDialog(false);
    fireEvent.click(screen.getByText('cloud.authDialog.manual-sign-in'));
    expect(
      (screen.getByRole('button', { name: 'cloud.authDialog.verify' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
