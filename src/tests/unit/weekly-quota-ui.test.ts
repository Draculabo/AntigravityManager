import { render, screen, cleanup } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WeeklyQuotaDisplay } from '@/modules/cloud-account/components/WeeklyQuotaDisplay';
import { DetailedQuotaDisplay } from '@/modules/cloud-account/components/DetailedQuotaDisplay';
import { AccountQuotaWindowSections } from '@/modules/cloud-account/components/AccountQuotaWindowSections';
import { CompactModelQuotaDisplay } from '@/modules/cloud-account/components/CompactModelQuotaDisplay';
import { selectWeeklyQuotaItems } from '@/modules/cloud-account/utils/quota-groups';
import {
  readQuotaWindowPreference,
  saveQuotaWindowPreference,
} from '@/modules/cloud-account/utils/quota-window-preference';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
const groups = [
  {
    display_name: 'Gemini Models',
    description: 'Provider limits',
    buckets: [
      {
        bucket_id: 'five-hour',
        window: '5h',
        display_name: 'Rolling window',
        remaining_fraction: 0.4,
        reset_time: '2099-01-01T00:00:00Z',
      },
      {
        bucket_id: 'weekly',
        window: 'WEEKLY',
        display_name: 'Seven days',
        remaining_fraction: 0.9,
        reset_time: '2099-01-02T00:00:00Z',
      },
    ],
  },
];

describe('quota window display', () => {
  it('retains detailed non-weekly buckets, including accounts without model entries', () => {
    render(createElement(DetailedQuotaDisplay, { groups }));
    expect(screen.getByText('Rolling window')).toBeTruthy();
    expect(screen.getByText('40%')).toBeTruthy();
    expect(screen.getByText('Provider limits')).toBeTruthy();
    expect(screen.queryByText('Seven days')).toBeNull();
  });
  it('shows an explicit empty weekly state instead of five-hour quota', () => {
    render(createElement(WeeklyQuotaDisplay, { items: [], hasQuotaSummary: false }));
    expect(screen.getByText('cloud.quota-window.no-weekly-quota')).toBeTruthy();
    expect(screen.getByText('cloud.quota-window.weekly-summary-unavailable')).toBeTruthy();
  });
  it('explains when a quota summary contains no recognizable weekly bucket', () => {
    render(createElement(WeeklyQuotaDisplay, { items: [], hasQuotaSummary: true }));
    expect(screen.getByText('cloud.quota-window.weekly-bucket-unavailable')).toBeTruthy();
  });
  it('exposes the compact weekly bar to keyboard and screen readers', () => {
    render(
      createElement(WeeklyQuotaDisplay, {
        items: selectWeeklyQuotaItems(groups),
        hasQuotaSummary: true,
        variant: 'compact',
      }),
    );
    const progress = screen.getByRole('progressbar', { name: 'Gemini: Seven days' });
    expect(progress.getAttribute('aria-valuenow')).toBe('90');
    expect(progress.getAttribute('tabindex')).toBe('0');
  });
  it('exposes compact five-hour quota as a labeled progress bar', () => {
    render(
      createElement(CompactModelQuotaDisplay, {
        items: [{ id: 'gemini-pro', label: 'Gemini Pro', percentage: 64 }],
      }),
    );

    expect(
      screen.getByRole('progressbar', { name: 'Gemini Pro' }).getAttribute('aria-valuenow'),
    ).toBe('64');
  });
  it('labels and groups every compact quota bar by window and model', () => {
    render(
      createElement(AccountQuotaWindowSections, {
        quotaWindow: 'both',
        fiveHourContent: createElement(CompactModelQuotaDisplay, {
          items: [
            { id: 'gemini-pro', label: 'Gemini Pro', percentage: 64 },
            { id: 'claude-sonnet', label: 'Claude Sonnet', percentage: 42 },
          ],
        }),
        weeklyItems: selectWeeklyQuotaItems(groups),
        hasQuotaSummary: true,
        variant: 'compact',
      }),
    );

    expect(screen.getByRole('group', { name: 'cloud.quota-window.five-hours-short' })).toBeTruthy();
    const geminiModelItem = screen.getByText('Gemini Pro').parentElement;
    expect(geminiModelItem?.classList.contains('flex-col')).toBe(true);
    expect(geminiModelItem?.lastElementChild?.getAttribute('role')).toBe('progressbar');
    expect(screen.getByText('Claude Sonnet')).toBeTruthy();
    expect(
      screen.getByRole('group', { name: 'cloud.quota-window.compact-weekly-short' }),
    ).toBeTruthy();
    const weeklyGeminiItem = screen.getByText('Gemini').parentElement;
    expect(weeklyGeminiItem?.classList.contains('flex-col')).toBe(true);
    expect(weeklyGeminiItem?.lastElementChild?.getAttribute('role')).toBe('progressbar');
  });
  it('shows five-hour and weekly quota together in the combined view', () => {
    render(
      createElement(AccountQuotaWindowSections, {
        quotaWindow: 'both',
        fiveHourContent: createElement('span', null, 'five-hour-content'),
        weeklyItems: selectWeeklyQuotaItems(groups),
        hasQuotaSummary: true,
      }),
    );

    expect(screen.getByText('five-hour-content')).toBeTruthy();
    expect(screen.getByText('Seven days')).toBeTruthy();
  });
  it('keeps the focused quota views mutually exclusive', () => {
    const { rerender } = render(
      createElement(AccountQuotaWindowSections, {
        quotaWindow: '5h',
        fiveHourContent: createElement('span', null, 'five-hour-content'),
        weeklyItems: selectWeeklyQuotaItems(groups),
        hasQuotaSummary: true,
      }),
    );

    expect(screen.getByText('five-hour-content')).toBeTruthy();
    expect(screen.queryByText('Seven days')).toBeNull();

    rerender(
      createElement(AccountQuotaWindowSections, {
        quotaWindow: 'weekly',
        fiveHourContent: createElement('span', null, 'five-hour-content'),
        weeklyItems: selectWeeklyQuotaItems(groups),
        hasQuotaSummary: true,
      }),
    );

    expect(screen.queryByText('five-hour-content')).toBeNull();
    expect(screen.getByText('Seven days')).toBeTruthy();
  });
  it('handles a throwing localStorage getter without losing the page', () => {
    const unavailable = () => {
      throw new Error('Storage unavailable');
    };
    expect(readQuotaWindowPreference(unavailable)).toBe('both');
    expect(() => saveQuotaWindowPreference(unavailable, 'weekly')).not.toThrow();
  });
});
