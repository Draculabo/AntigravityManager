import { describe, it, expect } from 'vitest';
import {
  applyJitter,
  calculateRetryDelay,
} from '../../modules/proxy-gateway/antigravity/retry-utils';

describe('applyJitter', () => {
  it('should return values within ±20% range', () => {
    const baseDelay = 1000;
    const results: number[] = [];

    for (let i = 0; i < 100; i++) {
      results.push(applyJitter(baseDelay));
    }

    // All values should be within 800-1200 range (±20%)
    results.forEach((r) => {
      expect(r).toBeGreaterThanOrEqual(800);
      expect(r).toBeLessThanOrEqual(1200);
    });
  });

  it('should produce different values (randomness)', () => {
    const results = new Set<number>();
    for (let i = 0; i < 20; i++) {
      results.add(applyJitter(1000));
    }
    // 20 calls should produce multiple distinct values
    expect(results.size).toBeGreaterThan(5);
  });

  it('should guarantee minimum value of 1 for small inputs', () => {
    expect(applyJitter(1)).toBeGreaterThanOrEqual(1);
    expect(applyJitter(0)).toBe(1);
  });
});

describe('calculateRetryDelay', () => {
  it('should implement exponential backoff', () => {
    // First attempt (index 0): 1s ± 20% = 800-1200ms
    const delay0 = calculateRetryDelay(0);
    expect(delay0).toBeGreaterThanOrEqual(800);
    expect(delay0).toBeLessThanOrEqual(1200);

    // Second attempt (index 1): 2s ± 20% = 1600-2400ms
    const delay1 = calculateRetryDelay(1);
    expect(delay1).toBeGreaterThanOrEqual(1600);
    expect(delay1).toBeLessThanOrEqual(2400);
  });

  it('should have maximum delay limit', () => {
    // Even with high retry count, should not exceed 30s + 20% jitter = 36s
    const delay = calculateRetryDelay(10);
    expect(delay).toBeLessThanOrEqual(36000);
  });

  it('should accept custom base delay', () => {
    const delay = calculateRetryDelay(0, 500);
    expect(delay).toBeGreaterThanOrEqual(400); // 500 - 20%
    expect(delay).toBeLessThanOrEqual(600); // 500 + 20%
  });
});
