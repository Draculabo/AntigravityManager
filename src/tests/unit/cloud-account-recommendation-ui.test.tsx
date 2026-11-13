import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CloudAccountList } from '@/modules/cloud-account/components/CloudAccountList';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';

const { mutate, queryState } = vi.hoisted(() => {
  const queryState: { data: CloudAccountView[]; isFetching: boolean; isSwitching: boolean } = {
    data: [],
    isFetching: false,
    isSwitching: false,
  };
  return { mutate: vi.fn(), queryState };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { language: 'en' }, t: (key: string) => key }),
}));
vi.mock('@/modules/cloud-account/hooks/useCloudAccounts', () => ({
  useCloudAccounts: () => queryState,
  useWeeklyWarmupConfig: () => ({}),
  useRefreshQuota: () => ({}),
  useDeleteCloudAccount: () => ({}),
  useSwitchCloudAccount: () => ({ mutate, isPending: queryState.isSwitching }),
  useAutoSwitchEnabled: () => ({}),
  useSetAutoSwitchEnabled: () => ({}),
  useForcePollCloudMonitor: () => ({}),
  useSetAccountRouting: () => ({}),
}));
vi.mock('@/modules/config/hooks/useAppConfig', () => ({ useAppConfig: () => ({}) }));
vi.mock('@/modules/cloud-account/hooks/useAccountModelAvailability', () => ({
  useAccountModelAvailability: () => [],
}));
vi.mock('@/modules/cloud-account/components/CurrentCycleUsage', () => ({
  CurrentCycleUsage: () => null,
}));
vi.mock('@/modules/cloud-account/components/CloudAccountToolbar', () => ({
  CloudAccountToolbar: () => null,
}));
vi.mock('@/modules/identity-profile/components/IdentityProfileDialog', () => ({
  IdentityProfileDialog: () => null,
}));

afterEach(() => {
  cleanup();
  mutate.mockClear();
  queryState.isFetching = false;
  queryState.isSwitching = false;
});

function account(id: string, weeklyBalance: number): CloudAccountView {
  const resetTime = new Date(Date.now() + 3_600_000).toISOString();
  return {
    id,
    provider: 'google',
    email: `${id}@example.test`,
    proxy_configured: false,
    status: 'active',
    created_at: 1,
    last_used: 1,
    is_active: true,
    is_active_classic: id === 'classic',
    is_active_ide: id === 'ide',
    is_active_agy: false,
    quota: {
      models: { 'gemini-3-pro': { percentage: 90, resetTime } },
      quota_groups: [
        {
          display_name: 'Gemini Models',
          buckets: [
            {
              bucket_id: 'gemini-weekly',
              window: 'weekly',
              remaining_fraction: weeklyBalance,
              reset_time: resetTime,
            },
          ],
        },
      ],
    },
  };
}

function chooseTarget(label: string) {
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'cloud.recommendation-target' }), {
    key: 'Enter',
  });
  fireEvent.keyDown(screen.getByRole('option', { name: label }), { key: 'Enter' });
}

it('updates the candidate as the client changes and switches the candidate in that client', () => {
  queryState.data = [account('classic', 0.9), account('ide', 0.8)];
  const view = render(<CloudAccountList />);
  const select = () => screen.getByRole('combobox', { name: 'cloud.recommendation-target' });
  const useRecommended = () =>
    screen.getByRole('button', { name: 'cloud.use-recommended-account' });

  expect(select().textContent).toBe('cloud.recommendation-target-classic');
  expect(screen.getByRole('status').textContent).toBe('ide@example.test');
  chooseTarget('cloud.card.client-ide');
  expect(screen.getByRole('status').textContent).toBe('classic@example.test');
  fireEvent.click(useRecommended());
  expect(mutate).toHaveBeenLastCalledWith(
    { accountId: 'classic', appTarget: 'ide' },
    expect.any(Object),
  );

  chooseTarget('cloud.card.client-cli');
  fireEvent.click(useRecommended());
  expect(mutate).toHaveBeenLastCalledWith(
    { accountId: 'classic', appTarget: 'agy' },
    expect.any(Object),
  );

  queryState.isSwitching = true;
  view.rerender(<CloudAccountList />);
  expect(select()).toHaveProperty('disabled', true);
  expect(useRecommended()).toHaveProperty('disabled', true);

  queryState.isSwitching = false;
  queryState.isFetching = true;
  view.rerender(<CloudAccountList />);
  expect(useRecommended()).toHaveProperty('disabled', true);
  expect(select()).toHaveProperty('disabled', false);
  expect(mutate).toHaveBeenCalledTimes(2);
});

it('explains an unavailable recommendation and keeps the target selector available', () => {
  queryState.data = [account('classic', 0.9)];
  render(<CloudAccountList />);

  const button = screen.getByRole('button', { name: 'cloud.use-recommended-account' });
  expect(screen.getByRole('status').textContent).toBe('cloud.no-target-recommendation');
  expect(button).toHaveProperty('disabled', true);
  chooseTarget('cloud.card.client-ide');
  expect(screen.getByRole('status').textContent).toBe('classic@example.test');
  expect(button).toHaveProperty('disabled', false);
});
