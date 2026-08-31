import { render, screen, cleanup } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WeeklyQuotaDisplay } from '@/modules/cloud-account/components/WeeklyQuotaDisplay';
import { DetailedQuotaDisplay } from '@/modules/cloud-account/components/DetailedQuotaDisplay';
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
  it('handles a throwing localStorage getter without losing the page', () => {
    const unavailable = () => {
      throw new Error('Storage unavailable');
    };
    expect(readQuotaWindowPreference(unavailable)).toBe('5h');
    expect(() => saveQuotaWindowPreference(unavailable, 'weekly')).not.toThrow();
  });
});
