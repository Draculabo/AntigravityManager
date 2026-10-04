import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CloudAccountCard,
  CompactCloudAccountCard,
} from '@/modules/cloud-account/components/CloudAccountCard';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';

const display = vi.hoisted(() => ({ grouped: false, showGeminiModel: false }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: [] }) }));
vi.mock('@/ipc/manager', () => ({ ipc: { client: {} } }));
vi.mock('@/modules/config/hooks/useAppConfig', () => ({
  useAppConfig: () => ({
    config: { model_visibility: { 'gemini-3-pro': display.showGeminiModel } },
    saveConfig: vi.fn(),
  }),
}));
vi.mock('@/modules/cloud-account/hooks/useProviderGrouping', async () => {
  const { groupModelsByProvider } = await import('@/modules/cloud-account/utils/provider-grouping');
  return {
    useProviderGrouping: () => ({
      enabled: display.grouped,
      getAccountStats: (account: CloudAccountView) =>
        groupModelsByProvider(account.quota?.models ?? {}, {}),
      isProviderCollapsed: () => false,
      toggleProviderCollapse: vi.fn(),
    }),
  };
});
vi.mock('@/modules/cloud-account/hooks/useOpenAccountValidationLink', () => ({
  useOpenAccountValidationLink: () => ({}),
}));
vi.mock('@/modules/cloud-account/components/CloudAccountProxyEditor', () => ({
  CloudAccountProxyEditor: () => null,
}));
afterEach(() => {
  cleanup();
  display.grouped = false;
  display.showGeminiModel = false;
});

const account: CloudAccountView = {
  id: 'synthetic-account',
  provider: 'google',
  email: 'test@example.com',
  name: 'Test',
  created_at: 1,
  last_used: 1,
  proxy_configured: false,
  quota: {
    models: {
      'gemini-3-pro': { percentage: 90, resetTime: '' },
      'claude-sonnet': { percentage: 80, resetTime: '' },
    },
    quota_groups: ['Gemini', 'Claude'].map((family) => ({
      display_name: `${family} Models`,
      buckets: ['5h', 'weekly'].map((window) => ({
        bucket_id: `${family.toLowerCase()}-${window}`,
        window,
        display_name: `${family} ${window}`,
        remaining_fraction: 0.7,
        reset_time: '2099-01-01T00:00:00Z',
      })),
    })),
  },
};
const callbacks = {
  onRefresh: vi.fn(),
  onDelete: vi.fn(),
  onSwitch: vi.fn(),
  onManageIdentity: vi.fn(),
};

describe('account quota group visibility', () => {
  it('filters provider groups without re-enabling hidden quota through the overall section', () => {
    display.grouped = true;
    display.showGeminiModel = true;
    render(
      createElement(CloudAccountCard, {
        account,
        ...callbacks,
        quotaGroupVisibility: {
          fiveHour: { gemini: false, claude: true },
          weekly: { gemini: false, claude: true },
        },
      }),
    );
    expect(screen.queryAllByText(/Gemini/)).toEqual([]);
    expect(screen.getAllByText('80%').length).toBeGreaterThan(0);
    expect(screen.getByText('Claude weekly')).toBeTruthy();
  });
  it.each([
    { name: 'card', Card: CloudAccountCard },
    { name: 'compact', Card: CompactCloudAccountCard },
  ])('can hide Gemini weekly quota independently of model visibility ($name)', ({ Card }) => {
    render(
      createElement(Card, {
        account,
        ...callbacks,
        quotaGroupVisibility: {
          fiveHour: { gemini: false, claude: true },
          weekly: { gemini: false, claude: true },
        },
      }),
    );
    expect(screen.queryByRole('progressbar', { name: 'Gemini: Gemini weekly' })).toBeNull();
    expect(screen.queryByText('Gemini weekly')).toBeNull();
    expect(screen.queryByText('Gemini 5h')).toBeNull();
    if (Card === CompactCloudAccountCard) {
      expect(screen.getByRole('progressbar', { name: 'Claude: Claude weekly' })).toBeTruthy();
    } else {
      expect(screen.getByText('Claude weekly')).toBeTruthy();
    }
  });
  it('does not report missing quota when all known groups are intentionally hidden', () => {
    render(
      createElement(CloudAccountCard, {
        account,
        ...callbacks,
        quotaGroupVisibility: {
          fiveHour: { gemini: false, claude: false },
          weekly: { gemini: false, claude: false },
        },
      }),
    );
    expect(screen.queryByText('cloud.card.noQuota')).toBeNull();
    expect(screen.queryByText('cloud.quota-window.no-weekly-quota')).toBeNull();
    expect(screen.queryByText('Claude 5h')).toBeNull();
    expect(screen.queryByText('Claude weekly')).toBeNull();
  });
});
