import { describe, expect, it } from 'vitest';

import {
  dateBoundary,
  toLocalDate,
} from '@/modules/proxy-gateway/traffic-monitor/traffic-date-range';

describe('traffic local-calendar date bounds', () => {
  it('covers both ends of the selected local dates', () => {
    const from = dateBoundary('2026-09-20', false)!;
    const to = dateBoundary('2026-09-21', true)!;
    expect(new Date(from).getHours()).toBe(0);
    expect(new Date(to).getHours()).toBe(23);
    expect(to - from).toBe(2 * 24 * 60 * 60 * 1000 - 1);
    expect(toLocalDate(from)).toBe('2026-09-20');
    expect(toLocalDate(to)).toBe('2026-09-21');
  });

  it('clears an empty bound', () => {
    expect(dateBoundary('', false)).toBeUndefined();
    expect(toLocalDate(undefined)).toBe('');
  });
});
