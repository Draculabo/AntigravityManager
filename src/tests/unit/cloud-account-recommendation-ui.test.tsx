import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CloudAccountList } from '@/modules/cloud-account/components/CloudAccountList';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import type { AppConfig } from '@/modules/config/types';

const { mutate, queryState } = vi.hoisted(() => {
  const queryState: {
    config?: Pick<AppConfig, 'account_sort' | 'model_visibility' | 'grid_layout'>;
    data: CloudAccountView[];
  } = {
    data: [],
  };
  return { mutate: vi.fn(), queryState };
});

vi.mock('react-i18next', async () => {
  const { createInstance } = await import('i18next');
  const { default: en } = await import('@/localization/en');
  const i18n = createInstance();
  await i18n.init({ lng: 'en', resources: { en: { translation: en } } });
  return { useTranslation: () => ({ i18n, t: i18n.t }) };
});
vi.mock('@/modules/cloud-account/hooks/useCloudAccounts', () => ({
  useCloudAccounts: () => queryState,
  useWeeklyWarmupConfig: () => ({}),
  useRefreshQuota: () => ({}),
  useDeleteCloudAccount: () => ({}),
  useSwitchCloudAccount: () => ({ mutate, isPending: false }),
  useAutoSwitchEnabled: () => ({}),
  useSetAutoSwitchEnabled: () => ({}),
  useForcePollCloudMonitor: () => ({}),
  useSetAccountRouting: () => ({}),
}));
vi.mock('@/modules/config/hooks/useAppConfig', () => ({
  useAppConfig: () => ({ config: queryState.config }),
}));
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
  queryState.config = undefined;
});

function account(id: string, gemini: number, claude: number): CloudAccountView {
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
    is_active_agy: id === 'cli',
    quota: {
      models: {
        'gemini-3.1-pro': { percentage: gemini, resetTime },
        'claude-sonnet-4-6': { percentage: claude, resetTime },
      },
    },
  };
}

it.each(['auto', 'compact'] as const)(
  'shows family and client recommendations on their cards and switches from Use (%s)',
  (gridLayout) => {
    queryState.config = {
      account_sort: 'quota-flash',
      model_visibility: { 'gemini-3.1-pro': false },
      grid_layout: gridLayout,
    };
    queryState.data = [account('classic', 95, 10), account('ide', 80, 90), account('cli', 70, 75)];
    render(<CloudAccountList />);

    const classic = within(screen.getByRole('article', { name: 'classic@example.test' }));
    const ide = within(screen.getByRole('article', { name: 'ide@example.test' }));
    const cli = within(screen.getByRole('article', { name: 'cli@example.test' }));
    expect(classic.getByText('Recommended Next · Gemini 5-hour quota 95% · IDE, CLI')).toBeTruthy();
    expect(ide.getByText('Recommended Next · Claude 5-hour quota 90% · App, CLI')).toBeTruthy();
    expect(cli.getByText('Recommended Next · Gemini 5-hour quota 70% · App')).toBeTruthy();
    expect(cli.getByText('Recommended Next · Claude 5-hour quota 75% · IDE')).toBeTruthy();
    expect(screen.getAllByText(/Recommended Next ·/)).toHaveLength(4);
    expect(screen.queryByRole('combobox')).toBeNull();

    fireEvent.keyDown(classic.getByRole('button', { name: 'Use' }), { key: 'ArrowDown' });
    expect(
      screen
        .getByRole('menuitem', { name: /Switch to Antigravity Active/ })
        .hasAttribute('data-disabled'),
    ).toBe(true);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Switch to Antigravity CLI' }));
    expect(mutate.mock.calls).toEqual([
      [{ accountId: 'classic', appTarget: 'agy' }, expect.any(Object)],
    ]);
  },
);

it('keeps manual switching available when there is no quota recommendation', () => {
  queryState.data = [{ ...account('ide', 80, 90), quota: undefined }];
  render(<CloudAccountList />);

  expect(screen.queryByText(/Recommended Next/)).toBeNull();
  fireEvent.keyDown(screen.getByRole('button', { name: 'Use' }), { key: 'ArrowDown' });
  fireEvent.click(screen.getByRole('menuitem', { name: 'Switch to Antigravity CLI' }));
  expect(mutate.mock.calls).toEqual([[{ accountId: 'ide', appTarget: 'agy' }, expect.any(Object)]]);
});
