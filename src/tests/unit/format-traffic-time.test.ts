import { describe, expect, it } from 'vitest';

import { formatTrafficTime } from '@/modules/proxy-gateway/traffic-monitor/format-traffic-time';

describe('traffic timestamp display', () => {
  it('formats a valid timestamp in local time and safely handles invalid data', () => {
    const timestamp = Date.UTC(2026, 8, 23, 9, 5, 7);
    const local = new Date(timestamp);
    const expected = [
      local.getFullYear(),
      String(local.getMonth() + 1).padStart(2, '0'),
      String(local.getDate()).padStart(2, '0'),
    ].join('-');
    expect(formatTrafficTime(timestamp)).toBe(
      `${expected} ${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}:${String(local.getSeconds()).padStart(2, '0')}`,
    );
    expect(formatTrafficTime(Number.NaN)).toBe('—');
  });
});
