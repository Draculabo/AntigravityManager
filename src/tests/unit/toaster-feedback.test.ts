import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Toaster } from '@/components/ui/toaster';
import { ToastAction, type ToastProps, type ToastActionElement } from '@/components/ui/toast';

const mocks = vi.hoisted(() => ({
  toasts: [] as Array<
    ToastProps & { id: string; title: string; description: string; action?: ToastActionElement }
  >,
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toasts: mocks.toasts }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => {
  cleanup();
  mocks.toasts = [];
});

it.each(['default', 'success', 'warning', 'destructive'] as const)(
  'keeps the %s notification readable and dismissible without hover',
  (variant) => {
    const onOpenChange = vi.fn();
    mocks.toasts = [
      {
        id: 'feedback',
        title: 'Synthetic notification',
        description: 'Synthetic detail',
        variant,
        open: true,
        onOpenChange,
      },
    ];
    render(createElement(Toaster));
    expect(screen.getByText('Synthetic notification')).toBeTruthy();
    expect(screen.getByText('Synthetic detail')).toBeTruthy();
    const close = screen.getByRole('button', { name: 'common.dismiss-notification' });
    close.focus();
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  },
);

it('preserves an actionable notification and its dismiss callback', () => {
  const action = vi.fn();
  const onOpenChange = vi.fn();
  mocks.toasts = [
    {
      id: 'action',
      title: 'Synthetic warning',
      description: 'Synthetic retry',
      variant: 'warning',
      open: true,
      onOpenChange,
      action: createElement(
        ToastAction,
        { altText: 'Retry this operation', onClick: action },
        'Retry',
      ),
    },
  ];
  render(createElement(Toaster));
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(action).toHaveBeenCalledTimes(1);
  expect(onOpenChange).toHaveBeenCalledWith(false);
});
