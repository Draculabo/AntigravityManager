import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { AccountTierBadge } from '@/modules/cloud-account/components/AccountTierBadge';
import { WeeklyQuotaDisplay } from '@/modules/cloud-account/components/WeeklyQuotaDisplay';
import { DetailedQuotaDisplay } from '@/modules/cloud-account/components/DetailedQuotaDisplay';
import { AccountQuotaWindowSections } from '@/modules/cloud-account/components/AccountQuotaWindowSections';
import { selectWeeklyQuotaItems } from '@/modules/cloud-account/utils/quota-groups';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import en from '@/localization/en';
import zh from '@/localization/zh-CN';
import fr from '@/localization/fr';
import ru from '@/localization/ru';
import tr from '@/localization/tr';
import viLocale from '@/localization/vi';

const i18n = createInstance();
const now = Date.parse('2026-10-17T00:00:00Z');
const groups = [
  {
    display_name: 'Claude Models',
    buckets: [
      {
        bucket_id: '5h',
        window: '5h',
        remaining_fraction: 0.8,
        reset_time: '2026-10-17T01:00:00Z',
        observed_at: now - 1000,
      },
      {
        bucket_id: 'weekly',
        window: 'weekly',
        remaining_fraction: 0,
        reset_time: '2026-10-20T00:00:00Z',
        observed_at: now - 2000,
      },
    ],
  },
];
const account: CloudAccountView = {
  id: 'synthetic-ui',
  provider: 'google',
  email: 'ui@example.test',
  created_at: 1,
  last_used: 1,
  proxy_configured: false,
  quota: {
    models: {},
    subscription_tier: 'pro',
    subscription_status: {
      refresh_status: 'failed',
      checked_at: now,
      observed_at: now - 1000,
      observation_status: 'known',
      source: 'paid-tier-id',
    },
  },
};
function show(element: ReturnType<typeof createElement>) {
  return render(createElement(I18nextProvider, { i18n }, element));
}
beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  await i18n.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en }, 'zh-CN': { translation: zh } },
    interpolation: { escapeValue: false },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('account observation and restriction UI', () => {
  it('keeps the paid label visible and makes failed-refresh details keyboard accessible', async () => {
    show(createElement(AccountTierBadge, { account, unknownLabel: 'Unknown' }));
    const note = screen.getByRole('note', { name: /Subscription refresh failed/ });
    expect(note.textContent).toBe('Pro');
    expect(note.getAttribute('tabindex')).toBe('0');
    fireEvent.focus(note);
    const tooltip = await screen.findByRole('tooltip');
    expect(within(tooltip).getByText('Source: paid subscription')).toBeTruthy();
    expect(tooltip.textContent).toContain(new Date(now - 1000).toLocaleString());
    expect(tooltip.textContent).toContain(new Date(now).toLocaleString());
  });
  it.each(['missing', 'unrecognized'] as const)(
    'explains the Free baseline for %s authority',
    (observation_status) => {
      show(
        createElement(AccountTierBadge, {
          account: {
            ...account,
            quota: {
              models: {},
              subscription_tier: 'free',
              subscription_status: {
                refresh_status: 'succeeded',
                checked_at: now,
                observation_status,
                source: 'none',
              },
            },
          },
          unknownLabel: 'Unknown',
        }),
      );
      expect(screen.getByRole('note').getAttribute('aria-label')).toContain('Free baseline');
      expect(screen.getByRole('note').getAttribute('aria-label')).toContain('Not recorded');
    },
  );
  it('does not label a legacy subscription as recently confirmed', () => {
    show(
      createElement(AccountTierBadge, {
        account: { ...account, quota: { models: {}, subscription_tier: 'pro' } },
        unknownLabel: 'Unknown',
      }),
    );
    expect(screen.getByRole('note').getAttribute('aria-label')).toContain(
      'source was not recorded',
    );
    expect(screen.getByRole('note').getAttribute('aria-label')).toContain('Not recorded');
  });
  it('does not imply a prior confirmed tier exists after a first failed lookup', () => {
    show(
      createElement(AccountTierBadge, {
        account: {
          ...account,
          quota: { models: {}, subscription_status: { refresh_status: 'failed', checked_at: now } },
        },
        unknownLabel: 'Unknown',
      }),
    );
    expect(screen.getByRole('note').getAttribute('aria-label')).toContain(
      'no previously confirmed tier is available',
    );
    expect(screen.getByRole('note').textContent).toBe('Unknown');
  });
  it('shows independent observations and explains weekly depletion despite a positive five-hour balance', () => {
    show(
      createElement(AccountQuotaWindowSections, {
        quotaWindow: 'both',
        restrictionGroups: groups,
        weeklyItems: selectWeeklyQuotaItems(groups),
        hasQuotaSummary: true,
        fiveHourContent: createElement(DetailedQuotaDisplay, { groups }),
      }),
    );
    expect(screen.getByText('80%')).toBeTruthy();
    expect(screen.getByText('0%')).toBeTruthy();
    expect(screen.getByText(/Weekly window depleted/)).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Quota group restrictions' }).textContent).toContain(
      new Date('2026-10-20T00:00:00Z').toLocaleString(),
    );
    expect(screen.getAllByText(/Last observed:/)).toHaveLength(2);
  });
  it('keeps group restrictions visible in a five-hour-only view', () => {
    show(
      createElement(AccountQuotaWindowSections, {
        quotaWindow: '5h',
        restrictionGroups: groups,
        weeklyItems: selectWeeklyQuotaItems(groups),
        hasQuotaSummary: true,
        fiveHourContent: createElement('span', null, '80%'),
      }),
    );
    expect(screen.getByRole('list', { name: 'Quota group restrictions' }).textContent).toContain(
      'Claude Models',
    );
    expect(screen.queryByText('0%')).toBeNull();
  });
  it('distinguishes a small positive balance displayed as zero from exhaustion', () => {
    const positive = [
      { ...groups[0], buckets: [{ ...groups[0].buckets[1], remaining_fraction: 0.004 }] },
    ];
    show(
      createElement(WeeklyQuotaDisplay, {
        items: selectWeeklyQuotaItems(positive),
        hasQuotaSummary: true,
      }),
    );
    expect(screen.getByText('0%')).toBeTruthy();
    expect(screen.getByText('Small positive balance; this window is not depleted.')).toBeTruthy();
    expect(screen.queryByText(/Weekly window depleted/)).toBeNull();
  });
  it('shows observations and recheck status through compact keyboard focus', async () => {
    const expired = [
      {
        ...groups[0],
        buckets: [
          { ...groups[0].buckets[1], reset_time: '2026-10-17T00:00:00Z', observed_at: undefined },
        ],
      },
    ];
    show(
      createElement(WeeklyQuotaDisplay, {
        items: selectWeeklyQuotaItems(expired),
        hasQuotaSummary: true,
        variant: 'compact',
      }),
    );
    fireEvent.focus(screen.getByRole('progressbar'));
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('Last observed: Not recorded');
    expect(tooltip.textContent).toContain('refresh is required to confirm recovery');
  });
  it('includes Chinese copy and matching evidence keys in every supported language', async () => {
    const keys = Object.keys(en['account-evidence']).sort();
    for (const resource of [zh, fr, ru, tr, viLocale]) {
      expect(Object.keys(resource['account-evidence']).sort()).toEqual(keys);
      for (const text of Object.values(resource['account-evidence'])) {
        expect(text.trim()).not.toBe('');
      }
    }
    await i18n.changeLanguage('zh-CN');
    show(createElement(AccountTierBadge, { account, unknownLabel: '未知' }));
    expect(screen.getByRole('note').getAttribute('aria-label')).toContain('正在显示此前记录');
  });
  it('changes depletion to recheck at the reset boundary without claiming recovery', () => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const depleted = [
      {
        ...groups[0],
        buckets: [{ ...groups[0].buckets[1], reset_time: new Date(now + 1000).toISOString() }],
      },
    ];
    show(
      createElement(AccountQuotaWindowSections, {
        quotaWindow: 'weekly',
        restrictionGroups: depleted,
        weeklyItems: selectWeeklyQuotaItems(depleted),
        hasQuotaSummary: true,
        fiveHourContent: null,
      }),
    );
    expect(screen.getByText(/Weekly window depleted/)).toBeTruthy();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByText(/Weekly window depleted/)).toBeNull();
    expect(screen.getAllByText(/refresh is required to confirm recovery/)).toHaveLength(2);
    expect(screen.getByText('0%')).toBeTruthy();
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });
});
