import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CloudAccountToolbar } from '@/modules/cloud-account/components/CloudAccountToolbar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string) => {
      const translations: Record<string, string> = {
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
vi.mock('@/modules/cloud-account/components/CloudAccountTransferMenu', () => ({
  CloudAccountTransferMenu: () => null,
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
