// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountProxyEditor } from '@/modules/cloud-account/components/CloudAccountProxyEditor';
import { isValidProxyUrl } from '@/shared/utils/url';

const { mutate, toast } = vi.hoisted(() => ({
  mutate: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@/modules/cloud-account/hooks/useCloudAccounts', () => ({
  useSetAccountProxy: () => ({ mutate, isPending: false }),
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe('cloud account proxy editor', () => {
  beforeEach(() => {
    mutate.mockReset();
    toast.mockReset();
  });

  it('accepts a replacement without receiving or displaying the stored proxy URL', () => {
    render(createElement(CloudAccountProxyEditor, { accountId: 'account-1', configured: true }));

    const input = screen.getByPlaceholderText('cloud.card.proxy-replace-placeholder');
    expect((input as HTMLInputElement).value).toBe('');
    fireEvent.change(input, {
      target: { value: '  http://new-user:new-password@127.0.0.1:7890  ' },
    });
    fireEvent.blur(input);

    expect(mutate).toHaveBeenCalledOnce();
    expect(mutate.mock.calls[0][0]).toEqual({
      accountId: 'account-1',
      proxyUrl: 'http://new-user:new-password@127.0.0.1:7890',
    });
  });

  it('removes a configured proxy without saving an unfinished replacement', () => {
    render(createElement(CloudAccountProxyEditor, { accountId: 'account-1', configured: true }));

    const input = screen.getByPlaceholderText('cloud.card.proxy-replace-placeholder');
    const remove = screen.getByRole('button', { name: 'cloud.card.proxy-remove' });
    fireEvent.change(input, { target: { value: 'http://new.example:7890' } });
    fireEvent.blur(input, { relatedTarget: remove });
    fireEvent.click(remove);

    expect(mutate).toHaveBeenCalledOnce();
    expect(mutate.mock.calls[0][0]).toEqual({ accountId: 'account-1', proxyUrl: null });
  });

  it('reports an invalid replacement without sending it', () => {
    render(createElement(CloudAccountProxyEditor, { accountId: 'account-1', configured: false }));

    const input = screen.getByPlaceholderText('cloud.card.proxyPlaceholder');
    fireEvent.change(input, { target: { value: 'invalid' } });
    expect((input as HTMLInputElement).value).toBe('invalid');
    expect(isValidProxyUrl('invalid')).toBe(false);
    fireEvent.blur(input);

    expect(mutate).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith({
      title: 'cloud.card.proxy-save-failed',
      variant: 'destructive',
    });
  });
});
