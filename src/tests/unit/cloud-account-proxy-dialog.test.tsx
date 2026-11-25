import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CloudAccountProxyDialog } from '@/modules/cloud-account/components/CloudAccountProxyDialog';

const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/modules/cloud-account/hooks/useCloudAccounts', () => ({
  useSetAccountRouting: () => ({ mutate, isPending: false }),
}));
vi.mock('@/modules/cloud-account/components/CloudAccountProxyEditor', () => ({
  CloudAccountProxyEditor: () => null,
}));

afterEach(cleanup);

it('saves changed overrides together and clears an override when its field is empty', () => {
  render(
    <CloudAccountProxyDialog
      accountId="account"
      configured={false}
      proxyPriority={50}
      proxyEnabled
      proxyPriorityOverrides={{ claude: 8 }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'cloud.card.network-proxy' }));
  const gemini = screen.getByRole('spinbutton', { name: 'cloud.card.proxy-priority-gemini' });
  const claude = screen.getByRole('spinbutton', { name: 'cloud.card.proxy-priority-claude' });
  expect(gemini).toHaveAttribute('placeholder', '50');
  expect(claude).toHaveValue(8);
  fireEvent.change(gemini, { target: { value: '30' } });
  fireEvent.change(claude, { target: { value: '' } });
  expect(mutate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'cloud.card.proxy-routing-save' }));
  expect(mutate).toHaveBeenCalledExactlyOnceWith(
    {
      accountId: 'account',
      proxyPriority: 50,
      proxyEnabled: true,
      proxyPriorityOverrides: { gemini: 30 },
    },
    expect.any(Object),
  );
});
