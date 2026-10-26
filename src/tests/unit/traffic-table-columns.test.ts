import { beforeEach, describe, expect, it } from 'vitest';

import {
  clampColumnWidth,
  readColumnWidths,
} from '@/modules/proxy-gateway/traffic-monitor/components/use-traffic-column-widths';

describe('traffic table column preferences', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('keeps widths within the supported resize range', () => {
    expect(clampColumnWidth(10)).toBe(45);
    expect(clampColumnWidth(120)).toBe(120);
    expect(clampColumnWidth(900)).toBe(640);
  });

  it('loads only known numeric widths and ignores malformed preferences', () => {
    const defaults = { time: 150, endpoint: 260 };
    localStorage.setItem(
      'traffic-table-columns:model',
      JSON.stringify({ time: 190, endpoint: 'wide', unknown: 500 }),
    );

    expect(readColumnWidths('model', ['time', 'endpoint'], defaults)).toEqual({
      time: 190,
      endpoint: 260,
    });

    localStorage.setItem('traffic-table-columns:model', '{bad');
    expect(readColumnWidths('model', ['time', 'endpoint'], defaults)).toEqual(defaults);
  });
  it('rejects non-finite JSON widths and arrays instead of poisoning grid layout', () => {
    localStorage.setItem('traffic-table-columns:model', '{"time":1e400}');
    expect(readColumnWidths('model', ['time'], { time: 150 })).toEqual({ time: 150 });
    localStorage.setItem('traffic-table-columns:model', '[190]');
    expect(readColumnWidths('model', ['time'], { time: 150 })).toEqual({ time: 150 });
  });
});
