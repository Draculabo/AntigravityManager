import { createElement, type ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountGrid } from '@/modules/cloud-account/components/CloudAccountGrid';
import { AccountSelectionProvider } from '@/modules/cloud-account/stores/AccountSelectionProvider';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import { filterAndSortCloudAccounts } from '@/modules/cloud-account/utils/account-tier-filter';

vi.mock('react-i18next', async () => {
  const { createInstance } = await import('i18next');
  const { default: en } = await import('@/localization/en');
  const i18n = createInstance();
  await i18n.init({ lng: 'en', resources: { en: { translation: en } } });
  return { useTranslation: () => ({ t: i18n.t, i18n }) };
});
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: [] }) }));
vi.mock('@/ipc/manager', () => ({ ipc: { client: {} } }));
vi.mock('@/modules/config/hooks/useAppConfig', () => ({
  useAppConfig: () => ({ config: { model_visibility: {} }, saveConfig: vi.fn() }),
}));
vi.mock('@/modules/cloud-account/hooks/useProviderGrouping', () => ({
  useProviderGrouping: () => ({ enabled: false }),
}));
vi.mock('@/modules/cloud-account/hooks/useOpenAccountValidationLink', () => ({
  useOpenAccountValidationLink: () => ({}),
}));
vi.mock('@/modules/cloud-account/components/CloudAccountProxyEditor', () => ({
  CloudAccountProxyEditor: () => null,
}));

afterEach(cleanup);

function account(id: string, state: Partial<CloudAccountView> = {}): CloudAccountView {
  return {
    id,
    provider: 'google',
    email: `${id}@example.invalid`,
    created_at: 1,
    last_used: 1,
    proxy_configured: false,
    is_active: false,
    is_active_classic: false,
    is_active_ide: false,
    is_active_agy: false,
    ...state,
  };
}

const gridProps: Omit<ComponentProps<typeof CloudAccountGrid>, 'accounts' | 'gridLayout'> = {
  sourceAccountCount: 3,
  quotaWindow: 'both',
  quotaGroupVisibility: {
    fiveHour: { gemini: true, claude: true },
    weekly: { gemini: true, claude: true },
  },
  manualRecommendation: null,
  hasActiveTierFilter: false,
  onRefresh: vi.fn(),
  onDelete: vi.fn(),
  onSwitch: vi.fn(),
  onManageIdentity: vi.fn(),
  onResetTierFilter: vi.fn(),
};

function card(id: string) {
  return within(screen.getByRole('article', { name: `${id}@example.invalid` }));
}

function usage(id: string) {
  return card(id).getByRole('group', { name: 'Client usage' }).textContent;
}

describe('cloud account active actions', () => {
  it.each(['auto', 'list', 'compact'] as const)(
    'keeps Use actions and independent client badges across ordering and filtering (%s)',
    (gridLayout) => {
      const ide = account('ide', { is_active: true, is_active_ide: true, last_used: 2 });
      const app = account('app', {
        is_active: true,
        is_active_classic: true,
        is_active_agy: true,
      });
      const idle = account('idle');
      const tree = (accounts: CloudAccountView[]) =>
        createElement(
          AccountSelectionProvider,
          null,
          createElement(CloudAccountGrid, { ...gridProps, gridLayout, accounts }),
        );
      const sorted = (accounts: CloudAccountView[]) =>
        filterAndSortCloudAccounts(accounts, {
          selectedTierKeys: [],
          sortKey: 'recently-used',
          modelVisibility: {},
        });
      const { rerender } = render(tree(sorted([ide, app, idle])));
      expect(screen.getAllByRole('button', { name: 'Use' })).toHaveLength(3);
      expect(usage('ide')).toBe('IDE');
      expect(usage('app')).toBe('AppCLI');
      expect(usage('idle')).toBe('Not in use');

      const refreshedApp = { ...app, last_used: 3 };
      const refreshed = sorted([ide, refreshedApp, idle]);
      expect(refreshed.map(({ id }) => id)).toEqual(['app', 'ide', 'idle']);
      rerender(tree(refreshed));
      expect(screen.getAllByRole('button', { name: 'Use' })).toHaveLength(3);
      expect(usage('ide')).toBe('IDE');
      expect(usage('app')).toBe('AppCLI');

      rerender(tree([ide, idle]));
      expect(screen.getAllByRole('button', { name: 'Use' })).toHaveLength(2);
      expect(usage('ide')).toBe('IDE');

      rerender(tree([idle]));
      expect(screen.getAllByRole('button', { name: 'Use' })).toHaveLength(1);
      expect(usage('idle')).toBe('Not in use');

      const cli = account('cli', { is_active: true, is_active_agy: true });
      rerender(tree([cli, idle]));
      expect(screen.getAllByRole('button', { name: 'Use' })).toHaveLength(2);
      expect(usage('cli')).toBe('CLI');
    },
  );

  it.each(['auto', 'compact'] as const)(
    'opens the Use menu by keyboard and only allows switching unused targets (%s)',
    (gridLayout) => {
      const onSwitch = vi.fn();
      render(
        createElement(
          AccountSelectionProvider,
          null,
          createElement(CloudAccountGrid, {
            ...gridProps,
            gridLayout,
            onSwitch,
            accounts: [account('app', { is_active_classic: true, is_active_agy: true })],
          }),
        ),
      );

      fireEvent.keyDown(card('app').getByRole('button', { name: 'Use' }), { key: 'ArrowDown' });
      expect(
        screen
          .getByRole('menuitem', { name: /Switch to Antigravity Active/ })
          .getAttribute('data-disabled'),
      ).toBe('');
      expect(
        screen
          .getByRole('menuitem', { name: /Switch to Antigravity CLI Active/ })
          .getAttribute('data-disabled'),
      ).toBe('');
      const ide = screen.getByRole('menuitem', { name: 'Switch to Antigravity IDE' });
      expect(ide.getAttribute('data-disabled')).toBeNull();
      fireEvent.click(ide);
      expect(onSwitch.mock.calls).toEqual([['app', 'ide']]);
    },
  );

  it.each(['auto', 'compact'] as const)(
    'keeps the Use label while switching and disables all target actions (%s)',
    (gridLayout) => {
      render(
        createElement(
          AccountSelectionProvider,
          null,
          createElement(CloudAccountGrid, {
            ...gridProps,
            gridLayout,
            switchingAccountId: 'app',
            accounts: [account('app', { is_active_classic: true })],
          }),
        ),
      );
      fireEvent.keyDown(card('app').getByRole('button', { name: 'Use' }), { key: 'ArrowDown' });
      expect(
        screen.getAllByRole('menuitem').map((item) => ({
          label: item.textContent,
          disabled: item.getAttribute('data-disabled'),
        })),
      ).toEqual([
        { label: 'Switch to AntigravityActive', disabled: '' },
        { label: 'Switch to Antigravity IDE', disabled: '' },
        { label: 'Switch to Antigravity CLI', disabled: '' },
        { label: 'Launch Isolated IDE', disabled: '' },
      ]);
    },
  );
});
