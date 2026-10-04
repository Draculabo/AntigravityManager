import { createElement, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProxyAccountStrategy } from '@/modules/proxy-gateway/components/ProxyAccountStrategy';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

it('saves a selected strategy and lets users retry after a failed save', async () => {
  const save = vi.fn(async (_value: 'balanced' | 'account-first') => {});
  save.mockRejectedValueOnce(new Error('Service unavailable'));
  function Setting() {
    const [value, setValue] = useState<'balanced' | 'account-first'>('balanced');
    return createElement(ProxyAccountStrategy, {
      value,
      onChange: async (next) => {
        await save(next);
        setValue(next);
      },
    });
  }
  render(createElement(Setting));
  const select = screen.getByRole('combobox', { name: 'proxy.account-strategy.title' });
  const choose = async () => {
    fireEvent.keyDown(select, { key: 'ArrowDown' });
    fireEvent.keyDown(
      await screen.findByRole('option', { name: 'proxy.account-strategy.account-first' }),
      { key: 'Enter' },
    );
  };
  await choose();
  expect((await screen.findByRole('alert')).textContent).toBe('proxy.account-strategy.save-failed');
  expect(select.textContent).toBe('proxy.account-strategy.balanced');
  await choose();
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(select.textContent).toBe('proxy.account-strategy.account-first');
  expect(save.mock.calls).toEqual([['account-first'], ['account-first']]);
  expect(screen.getByText('proxy.account-strategy.client-description')).toBeTruthy();
});
