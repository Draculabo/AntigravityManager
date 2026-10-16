import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CloudAccountListSummary } from '@/modules/cloud-account/components/CloudAccountListSummary';
import { CloudAccountToolbar } from '@/modules/cloud-account/components/CloudAccountToolbar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'cloud.title': 'Accounts',
        'cloud.description': 'Manage your Google Gemini accounts.',
        'cloud.total-accounts': 'Total accounts',
        'cloud.card.active': 'Active',
        'cloud.card.rateLimited': 'Rate Limited',
        'cloud.globalQuota': 'Global Quota',
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

describe('CloudAccountListSummary minimal mode', () => {
  it('renders standard full-size cards when minimal mode is off', () => {
    const { container } = render(
      React.createElement(CloudAccountListSummary, {
        totalAccounts: 5,
        activeAccounts: 1,
        rateLimitedAccounts: 0,
        overallQuotaPercentage: 82.8,
        effectiveQuotaStatus: 'high',
        isMinimalMode: false,
      }),
    );

    expect(screen.getByText('Accounts')).not.toBeNull();
    expect(screen.getByText('Manage your Google Gemini accounts.')).not.toBeNull();
    expect(screen.getByText('5')).not.toBeNull();
    expect(screen.getByText('1')).not.toBeNull();
    expect(screen.getByText('0')).not.toBeNull();
    expect(screen.getByText('82.8%')).not.toBeNull();

    const standardDl = container.querySelector('dl.grid-cols-2.xl\\:grid-cols-4');
    expect(standardDl).not.toBeNull();
  });

  it('renders compact inline stats on the right of header when minimal mode is on', () => {
    const { container } = render(
      React.createElement(CloudAccountListSummary, {
        totalAccounts: 5,
        activeAccounts: 1,
        rateLimitedAccounts: 0,
        overallQuotaPercentage: 82.8,
        effectiveQuotaStatus: 'high',
        isMinimalMode: true,
      }),
    );

    expect(screen.getByText('Accounts')).not.toBeNull();
    expect(screen.getByText('Manage your Google Gemini accounts.')).not.toBeNull();
    expect(screen.getByText('5')).not.toBeNull();
    expect(screen.getByText('1')).not.toBeNull();
    expect(screen.getByText('0')).not.toBeNull();
    expect(screen.getByText('82.8%')).not.toBeNull();

    // The standard large cards grid should not exist
    const standardDl = container.querySelector('dl.grid-cols-2.xl\\:grid-cols-4');
    expect(standardDl).toBeNull();

    // The compact summary dl should exist with background color styling
    const compactDl = container.querySelector('dl.divide-border');
    expect(compactDl).not.toBeNull();
    expect(container.querySelector('.bg-info-soft')).not.toBeNull();
    expect(container.querySelector('.bg-success-soft')).not.toBeNull();
    expect(container.querySelector('.bg-warning-soft')).not.toBeNull();
    expect(container.querySelector('.bg-card')).not.toBeNull();
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
