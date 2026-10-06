import { createElement, type ComponentProps } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountGrid } from '@/modules/cloud-account/components/CloudAccountGrid';
import { CloudAccountSelectAllButton } from '@/modules/cloud-account/components/CloudAccountSelectAllButton';
import { CloudAccountBatchActionBar } from '@/modules/cloud-account/components/CloudAccountBatchActionBar';
import {
  AccountSelectionProvider,
  useAccountSelectionStore,
} from '@/modules/cloud-account/stores/AccountSelectionProvider';
import {
  createAccountSelectionStore,
  getSelectedVisibleAccountIds,
  type AccountSelectionStore,
} from '@/modules/cloud-account/stores/account-selection';
import type { CloudAccountCard } from '@/modules/cloud-account/components/CloudAccountCard';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';

const renders = vi.hoisted(() => ({ cards: new Map<string, number>(), page: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count: number }) => (options ? `${key}:${options.count}` : key),
  }),
}));
vi.mock('@/modules/cloud-account/components/CloudAccountCard', () => ({
  CloudAccountCard: ({
    account,
    isSelected,
    onToggleSelection,
  }: ComponentProps<typeof CloudAccountCard>) => {
    renders.cards.set(account.id, (renders.cards.get(account.id) ?? 0) + 1);
    return createElement(
      'button',
      {
        'aria-label': account.id,
        'aria-pressed': isSelected,
        onClick: () => onToggleSelection?.(account.id, !isSelected),
      },
      account.id,
    );
  },
  CompactCloudAccountCard: () => null,
}));

afterEach(() => {
  cleanup();
  renders.cards.clear();
  renders.page.mockClear();
});

const accounts: CloudAccountView[] = Array.from({ length: 100 }, (_, index) => ({
  id: `account-${index}`,
  provider: 'google',
  email: `test-${index}@example.com`,
  created_at: 1,
  last_used: 1,
  proxy_configured: false,
}));
const visibleIds = accounts.map((account) => account.id);
const gridProps: ComponentProps<typeof CloudAccountGrid> = {
  accounts,
  sourceAccountCount: accounts.length,
  gridLayout: 'auto',
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

function AccountPage() {
  renders.page();
  return createElement(
    AccountSelectionProvider,
    null,
    createElement(CloudAccountSelectAllButton, { visibleAccountIds: visibleIds }),
    createElement(CloudAccountGrid, gridProps),
    createElement(CloudAccountBatchActionBar, {
      visibleAccountIds: visibleIds,
      onRefreshSelected: vi.fn(),
      onDeleteSelected: vi.fn(),
    }),
  );
}

describe('account selection subscriptions', () => {
  it('renders only the selected card among 100 cards and leaves its page unchanged', () => {
    render(createElement(AccountPage));
    expect(renders.page).toHaveBeenCalledOnce();
    expect(Array.from(renders.cards.values())).toEqual(Array(100).fill(1));
    renders.cards.clear();
    fireEvent.click(screen.getByRole('button', { name: 'account-42' }));
    expect(Object.fromEntries(renders.cards)).toEqual({ 'account-42': 1 });
    expect(renders.page).toHaveBeenCalledOnce();
    expect(screen.getByText('cloud.batch.selected:1')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'account-42' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    renders.cards.clear();
    fireEvent.click(screen.getByRole('button', { name: 'account-42' }));
    expect(Object.fromEntries(renders.cards)).toEqual({ 'account-42': 1 });
    expect(screen.queryByText('cloud.batch.selected:1')).toBeNull();
  });

  it('selects and clears all visible cards without rerendering the page', () => {
    render(createElement(AccountPage));
    fireEvent.click(screen.getByRole('button', { name: 'cloud.batch.selectAll' }));
    expect(screen.getByText('cloud.batch.selected:100')).toBeTruthy();
    expect(Array.from(renders.cards.values())).toEqual(Array(100).fill(2));
    fireEvent.click(screen.getByRole('button', { name: 'cloud.batch.selectAll' }));
    expect(screen.queryByText('cloud.batch.selected:100')).toBeNull();
    expect(Array.from(renders.cards.values())).toEqual(Array(100).fill(3));
    expect(renders.page).toHaveBeenCalledOnce();
  });

  it('keeps hidden selections and applies bulk actions only to currently visible accounts', () => {
    const store = createAccountSelectionStore();
    store.getState().setSelected('hidden', true);
    store.getState().setSelected('visible', true);
    expect(getSelectedVisibleAccountIds(store.getState().selectedIds, ['visible'])).toEqual([
      'visible',
    ]);
    expect(
      getSelectedVisibleAccountIds(store.getState().selectedIds, ['visible', 'hidden']),
    ).toEqual(['hidden', 'visible']);
    store.getState().toggleVisible(['other']);
    expect(Array.from(store.getState().selectedIds)).toEqual(['other']);
    store.getState().toggleVisible(['other']);
    expect(Array.from(store.getState().selectedIds)).toEqual([]);
  });

  it('isolates mounted pages and resets selection when the page remounts', () => {
    const stores: AccountSelectionStore[] = [];
    function CaptureStore() {
      stores.push(useAccountSelectionStore());
      return null;
    }
    const tree = () => createElement(AccountSelectionProvider, null, createElement(CaptureStore));
    const firstPage = render(tree());
    render(tree());
    act(() => stores[0].getState().setSelected('account-1', true));
    expect(Array.from(stores[0].getState().selectedIds)).toEqual(['account-1']);
    expect(Array.from(stores[1].getState().selectedIds)).toEqual([]);
    firstPage.unmount();
    render(tree());
    expect(Array.from(stores[2].getState().selectedIds)).toEqual([]);
  });
});
