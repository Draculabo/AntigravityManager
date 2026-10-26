import { describe, expect, it } from 'vitest';
import {
  getQuotaGroupModelMembership,
  normalizeQuotaModelId,
} from '@/modules/cloud-account/utils/quota-group-model-membership';
import { modelQuotaWindows } from '@/modules/cloud-account/utils/quota-windows';
import type { CloudQuotaGroup } from '@/modules/cloud-account/types';

const bucket = {
  bucket_id: '3p-weekly',
  window: 'weekly',
  remaining_fraction: 0.5,
  reset_time: '2090-01-01T00:00:00Z',
};

function group(overrides: Partial<CloudQuotaGroup> = {}): CloudQuotaGroup {
  return {
    display_name: 'Claude and GPT models',
    buckets: [bucket],
    ...overrides,
  };
}

describe('quota group physical model membership', () => {
  it('normalizes only the provider models prefix and outer whitespace', () => {
    expect(normalizeQuotaModelId('  models/Claude-Sonnet-4-6  ')).toBe('claude-sonnet-4-6');
  });

  it('uses an explicit model list as authoritative evidence', () => {
    const value = group({ model_ids: ['models/claude-sonnet-4-6'] });
    expect(getQuotaGroupModelMembership(value, 'claude-sonnet-4-6')).toBe('authoritative');
    expect(getQuotaGroupModelMembership(value, 'gpt-4o')).toBe('unknown');
    expect(modelQuotaWindows({ models: {}, quota_groups: [value] }, 'gpt-4o')).toEqual([]);
  });

  it('keeps the legacy label matcher only when the provider omitted membership', () => {
    const value = group();
    expect(getQuotaGroupModelMembership(value, 'claude-sonnet-4-6')).toBe('legacy');
    expect(modelQuotaWindows({ models: {}, quota_groups: [value] }, 'claude-sonnet-4-6')).toEqual([
      bucket,
    ]);
  });

  it('does not let an empty authoritative list fall back to a broad label', () => {
    const value = group({ model_ids: [] });
    expect(getQuotaGroupModelMembership(value, 'claude-sonnet-4-6')).toBe('unknown');
    expect(modelQuotaWindows({ models: {}, quota_groups: [value] }, 'claude-sonnet-4-6')).toEqual(
      [],
    );
  });
});
