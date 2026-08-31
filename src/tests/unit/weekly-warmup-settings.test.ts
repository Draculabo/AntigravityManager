import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WeeklyWarmupSettings } from '@/modules/cloud-account/components/WeeklyWarmupSettings';

const state = vi.hoisted(() => ({
  query: {
    data: { enabled: true, groups: ['claude', 'gemini'] },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  mutation: { mutate: vi.fn(), isPending: false, isError: false },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/modules/cloud-account/hooks/useCloudAccounts', () => ({
  useWeeklyWarmupConfig: () => state.query,
  useSetWeeklyWarmupConfig: () => state.mutation,
}));
beforeEach(() => {
  vi.clearAllMocks();
  state.query.isError = false;
  state.query.isLoading = false;
  state.mutation.isPending = false;
  state.mutation.isError = false;
});
afterEach(cleanup);
describe('weekly warmup settings', () => {
  it('blocks changes when loading or a write is pending', () => {
    state.query.isLoading = true;
    const view = render(createElement(WeeklyWarmupSettings));
    for (const control of screen.getAllByRole('switch')) {
      expect(control.hasAttribute('disabled')).toBe(true);
    }
    state.query.isLoading = false;
    state.mutation.isPending = true;
    view.rerender(createElement(WeeklyWarmupSettings));
    fireEvent.click(screen.getByRole('switch', { name: 'settings.weekly-warmup.enabled' }));
    expect(state.mutation.mutate).not.toHaveBeenCalled();
  });
  it('surfaces a failed read and offers retry without writing defaults', () => {
    state.query.isError = true;
    render(createElement(WeeklyWarmupSettings));
    expect(screen.getByRole('alert').textContent).toBe('settings.weekly-warmup.error');
    fireEvent.click(screen.getByRole('button', { name: 'settings.weekly-warmup.retry' }));
    expect(state.query.refetch).toHaveBeenCalledOnce();
    expect(state.mutation.mutate).not.toHaveBeenCalled();
  });
  it('changes only the selected group and exposes quota consumption', () => {
    render(createElement(WeeklyWarmupSettings));
    fireEvent.click(screen.getByRole('switch', { name: 'settings.weekly-warmup.group.claude' }));
    expect(state.mutation.mutate).toHaveBeenCalledExactlyOnceWith({
      enabled: true,
      groups: ['gemini'],
    });
    expect(screen.getByText('settings.weekly-warmup.cost-notice')).toBeTruthy();
  });
  it('surfaces a failed write while leaving the saved configuration visible', () => {
    state.mutation.isError = true;
    render(createElement(WeeklyWarmupSettings));
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(
      screen
        .getByRole('switch', { name: 'settings.weekly-warmup.enabled' })
        .getAttribute('aria-checked'),
    ).toBe('true');
  });
});
