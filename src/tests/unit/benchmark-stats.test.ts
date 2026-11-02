import { describe, expect, it } from 'vitest';
import {
  MIN_BENCHMARK_SAMPLES,
  percentile,
  summarize,
} from '@/modules/proxy-gateway/playground/benchmark-stats';

describe('benchmark statistics', () => {
  it('interpolates percentiles over an ascending sample', () => {
    expect(percentile([10, 20, 30, 40], 0)).toBe(10);
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(percentile([10, 20, 30, 40], 1)).toBe(40);
    expect(percentile([], 0.5)).toBeUndefined();
  });

  it('reports the median from any sample size', () => {
    expect(summarize([30, 10, 20]).median).toBe(20);
    expect(summarize([10]).median).toBe(10);
    expect(summarize([10, 30]).median).toBe(20);
  });

  it('withholds p95 below the documented minimum', () => {
    const less = summarize([10, 20]);
    expect(less.count).toBe(2);
    expect(less.median).toBe(15);
    expect(less.p95).toBeUndefined();

    const enough = summarize([10, 20, 30]);
    expect(enough.count).toBe(MIN_BENCHMARK_SAMPLES);
    expect(enough.p95).toBe(29);
  });

  it('returns an empty summary for no samples', () => {
    expect(summarize([])).toEqual({ count: 0, median: undefined, p95: undefined });
  });
});
