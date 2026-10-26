import { describe, expect, it } from 'vitest';
import {
  hasFreshQuotaWindows,
  mergeQuotaWindows,
} from '@/modules/cloud-account/utils/quota-windows';
import { CloudQuotaDataSchema, type CloudQuotaData } from '@/modules/cloud-account/types';

const model = 'claude-sonnet-4-6';
function quota(fraction: number, observedAt?: number, window = 'weekly'): CloudQuotaData {
  return {
    models: { [model]: { percentage: 80, resetTime: '2090-01-01T01:00:00Z' } },
    quota_groups: [
      {
        display_name: 'Claude and GPT models',
        buckets: [
          {
            bucket_id: '3p-weekly',
            window,
            remaining_fraction: fraction,
            reset_time: '2090-01-04T00:00:00Z',
            ...(observedAt === undefined ? {} : { observed_at: observedAt }),
          },
        ],
      },
    ],
  };
}

describe('quota-window observation evidence', () => {
  it('keeps expired depletion as probe evidence and rejects a positive value from an expired cycle', () => {
    const previous = quota(0, 200);
    previous.quota_groups![0].buckets[0].reset_time = '2000-01-01T00:00:00Z';
    const stale = quota(0.8, 300);
    stale.quota_groups![0].buckets[0].reset_time = '2000-01-01T00:00:00Z';
    expect(mergeQuotaWindows(previous, { models: previous.models }).quota_groups).toEqual(
      previous.quota_groups,
    );
    expect(mergeQuotaWindows(previous, stale).quota_groups).toEqual(previous.quota_groups);
    expect(hasFreshQuotaWindows(previous, stale, model)).toBe(false);
  });
  it('still accepts a newly reported depletion if the local clock moved backwards', () => {
    const previous = quota(0.8, 200);
    const depleted = quota(0, 100);
    expect(mergeQuotaWindows(previous, depleted)).toEqual(depleted);
    expect(hasFreshQuotaWindows(previous, depleted, model)).toBe(false);
  });

  it('does not replace a newer depletion with an older positive observation', () => {
    const previous = quota(0, 200);
    const next = quota(0.8, 100);
    expect(mergeQuotaWindows(previous, next).quota_groups).toEqual(previous.quota_groups);
    expect(hasFreshQuotaWindows(previous, next, model)).toBe(false);
    expect(next).toEqual(quota(0.8, 100));
  });

  it('does not promote a timestamp-free snapshot over a recorded observation', () => {
    const previous = quota(0, 200);
    const next = quota(0.8);
    expect(mergeQuotaWindows(previous, next).quota_groups).toEqual(previous.quota_groups);
    expect(hasFreshQuotaWindows(previous, next, model)).toBe(false);
  });

  it.each(['', 'invalid-reset'])('does not certify recovery with malformed reset %s', (reset) => {
    const previous = quota(0, 200);
    const next = quota(0.8, 300);
    next.quota_groups![0].buckets[0].reset_time = reset;
    expect(mergeQuotaWindows(previous, next).quota_groups).toEqual(previous.quota_groups);
    expect(hasFreshQuotaWindows(previous, next, model)).toBe(false);
  });

  it('retains the original observation time when a later refresh omits a bucket', () => {
    const previous = quota(0, 200);
    expect(mergeQuotaWindows(previous, { models: previous.models }, 300).quota_groups).toEqual(
      previous.quota_groups,
    );
  });

  it('accepts a newer matching observation and remains idempotent when remerged', () => {
    const previous = quota(0, 200);
    const next = quota(0.8, 300);
    const merged = mergeQuotaWindows(previous, next);
    expect(merged).toEqual(next);
    expect(mergeQuotaWindows(merged, next)).toEqual(next);
    expect(hasFreshQuotaWindows(previous, next, model)).toBe(true);
  });

  it.each(['7d', ' Weekly ', 'week'])('matches weekly identity across alias %s', (window) => {
    const previous = quota(0, 200);
    const next = quota(0.8, 300, window);
    expect(mergeQuotaWindows(previous, next)).toEqual(next);
    expect(hasFreshQuotaWindows(previous, next, model)).toBe(true);
  });

  it('does not use a different bucket ID or an empty ID to certify recovery', () => {
    const previous = quota(0, 200);
    for (const id of ['', '3p-other-weekly']) {
      const next = quota(0.8, 300);
      next.quota_groups![0].buckets[0].bucket_id = id;
      expect(hasFreshQuotaWindows(previous, next, model)).toBe(false);
    }
    const unknown = quota(0, 200);
    unknown.quota_groups![0].buckets[0].bucket_id = '';
    expect(hasFreshQuotaWindows(unknown, unknown, model)).toBe(false);
  });

  it('reads old snapshots without inventing observation times', () => {
    const old = quota(0);
    expect(CloudQuotaDataSchema.parse(old)).toEqual(old);
    expect(mergeQuotaWindows(old, { models: old.models }).quota_groups).toEqual(old.quota_groups);
  });

  it('preserves observation times through the persisted boundary codec', () => {
    const current = quota(0, 200);
    expect(CloudQuotaDataSchema.parse(JSON.parse(JSON.stringify(current)))).toEqual(current);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects malformed persisted observation time %s',
    (time) => {
      expect(CloudQuotaDataSchema.safeParse(quota(0, time)).success).toBe(false);
    },
  );
});
