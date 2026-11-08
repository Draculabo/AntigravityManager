import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CloudAccountListSummary } from '@/modules/cloud-account/components/CloudAccountListSummary';
import type { AccountPoolSummary } from '@/modules/cloud-account/utils/account-pool-summary';
import { CloudAccountToolbar } from '@/modules/cloud-account/components/CloudAccountToolbar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string) => {
      const translations: Record<string, string> = {
        'cloud.title': 'Accounts',
        'cloud.description': 'Manage your Google Gemini accounts.',
        'cloud.total-accounts': 'Total accounts',
        'cloud.card.active': 'Active',
        'cloud.card.rateLimited': 'Rate Limited',
        'cloud.globalQuota': 'Global Quota',
        'cloud.weeklyQuota': 'Weekly Quota',
        'cloud.auto-switch-client': 'Auto-switch client account',
        'cloud.minimal-mode': 'Minimal mode',
      };
      return translations[key] ?? key;
    },
  }),
}));

vi.mock('@/modules/cloud-account/components/CloudAccountLoginDialog', () => ({
  CloudAccountLoginDialog: () => null,
}));
vi.mock('@/modules/cloud-account/components/CloudAccountFileDialogs', () => ({
  CloudAccountFileDialogs: () => null,
}));
vi.mock('@/modules/cloud-account/local-import/components/LocalAccountImportDialog', () => ({
  LocalAccountImportDialog: () => null,
}));
vi.mock('@/modules/cloud-account/components/CloudAccountSelectAllButton', () => ({
  CloudAccountSelectAllButton: () => null,
}));
vi.mock('@/modules/cloud-account/components/AccountTierFilterDropdown', () => ({
  AccountTierFilterDropdown: () => null,
}));
vi.mock('@/modules/cloud-account/components/QuotaGroupVisibilityMenu', () => ({
  QuotaGroupVisibilityMenu: () => null,
}));

describe('CloudAccountListSummary', () => {
  it('shows pool counts and the account health details', () => {
    const summary: AccountPoolSummary = {
      totalAccounts: 5,
      sourceAccountCount: 5,
      states: { 'enabled-normal': 2, disabled: 1, exception: 1, unknown: 1 },
      accounts: [{ id: 'sample', label: 'Sample account', state: 'enabled-normal' }],
      currentClientAccounts: 1,
      rateLimitedAccounts: 0,
      scope: 'enabled-normal',
      scopeAccountCount: 2,
      families: [],
    };

    render(React.createElement(CloudAccountListSummary, { summary, onScopeChange: vi.fn() }));

    expect(screen.getByRole('heading', { name: 'Accounts' })).toBeTruthy();
    expect(screen.getByText('Manage your Google Gemini accounts.')).toBeTruthy();
    expect(screen.getByText('Total accounts').nextElementSibling?.textContent).toBe('5');
    expect(
      screen.getByText('cloud.pool-summary.enabled-normal', { selector: 'dt' }).nextElementSibling
        ?.textContent,
    ).toBe('2');
    expect(
      screen.getByText('cloud.pool-summary.rate-limited').nextElementSibling?.textContent,
    ).toBe('0');
    expect(screen.getByText('Sample account').nextElementSibling?.textContent).toBe(
      'cloud.pool-summary.enabled-normal',
    );
  });
});

describe('CloudAccountToolbar minimal mode', () => {
  const baseProps = {
    visibleAccountIds: [],
    autoSwitchEnabled: false,
    isSettingsLoading: false,
    isSetAutoSwitchPending: false,
    isForcePollPending: false,
    tierOptions: [],
    effectiveSelectedTierKeySet: new Set<string>(),
    hasActiveTierFilter: false,
    tierFilterButtonLabel: 'All tiers',
    currentSort: 'recently-used' as const,
    gridLayout: 'auto' as const,
    quotaWindow: 'both' as const,
    quotaGroupVisibility: {
      fiveHour: { gemini: true, claude: true },
      weekly: { gemini: true, claude: true },
    },
    getTierOptionLabel: (_key: string, label: string) => label,
    onToggleAutoSwitch: vi.fn(),
    onForcePoll: vi.fn(),
    onResetTierFilter: vi.fn(),
    onToggleTierFilter: vi.fn(),
    onSortChange: vi.fn(),
    onUpdateGridLayout: vi.fn(),
    onQuotaWindowChange: vi.fn(),
    onQuotaGroupVisibilityChange: vi.fn(),
    onToggleMinimalMode: vi.fn(),
  };

  it('renders auto-switch row when minimal mode is off', () => {
    render(React.createElement(CloudAccountToolbar, { ...baseProps, isMinimalMode: false }));

    expect(screen.getByText('Auto-switch client account')).not.toBeNull();
    expect(screen.getByText('Minimal mode')).not.toBeNull();
  });

  it('hides auto-switch row when minimal mode is on', () => {
    render(React.createElement(CloudAccountToolbar, { ...baseProps, isMinimalMode: true }));

    expect(screen.queryByText('Auto-switch client account')).toBeNull();
    expect(screen.getByText('Minimal mode')).not.toBeNull();
  });
});
