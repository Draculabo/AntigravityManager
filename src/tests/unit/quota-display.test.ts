import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  formatTimeRemaining,
  parseQuotaResetTime,
} from '@/modules/cloud-account/utils/quota-display';

describe('quota reset-time formatting', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('interprets up-to-ten-digit numeric values as Unix seconds', () => {
    const target = Date.UTC(2026, 0, 1, 2, 30, 0);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)));

    expect(parseQuotaResetTime(String(Math.floor(target / 1000)))?.getTime()).toBe(target);
    expect(formatTimeRemaining(String(Math.floor(target / 1000)))).toBe('2h 30m');
  });

  it('interprets longer numeric values as Unix milliseconds', () => {
    const target = Date.UTC(2026, 0, 2, 1, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)));

    expect(parseQuotaResetTime(String(target))?.getTime()).toBe(target);
    expect(formatTimeRemaining(String(target))).toBe('1d 1h');
  });

  it('keeps invalid values unknown instead of producing a malformed date', () => {
    expect(parseQuotaResetTime('not-a-reset-time')).toBeNull();
    expect(formatTimeRemaining('not-a-reset-time')).toBeNull();
  });
});
