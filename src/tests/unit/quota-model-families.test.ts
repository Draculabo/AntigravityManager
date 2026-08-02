import { describe, expect, it } from 'vitest';
import {
  aggregateQuotaModelFamilies,
  aggregateVisibleQuotaModelFamilies,
  getQuotaModelFamilyId,
} from '@/modules/cloud-account/utils/quota-model-families';
import type { CloudQuotaModelInfo } from '@/modules/cloud-account/types';

function quota(percentage: number, resetTime: string): CloudQuotaModelInfo {
  return {
    percentage,
    resetTime,
  };
}

describe('quota model families', () => {
  it('uses the minimum remaining quota and earliest reset in a registered family', () => {
    const aggregated = aggregateQuotaModelFamilies({
      'gemini-3.1-pro-low': quota(80, '2026-07-30T10:00:00.000Z'),
      'gemini-pro-agent': quota(5, '2026-07-30T12:00:00.000Z'),
      'gemini-3.1-pro-preview': quota(40, '2026-07-30T08:00:00.000Z'),
    });

    expect(aggregated['gemini-3.1-pro']).toMatchObject({
      percentage: 5,
      resetTime: '2026-07-30T08:00:00.000Z',
      display_name: 'Gemini 3.1 Pro',
    });
    expect(Object.keys(aggregated)).toEqual(['gemini-3.1-pro']);
  });

  it('aggregates Flash aliases without filtering thinking model names', () => {
    const aggregated = aggregateQuotaModelFamilies({
      'gemini-2.5-flash': quota(60, '2026-07-30T12:00:00.000Z'),
      'gemini-2.5-flash-thinking': quota(7, '2026-07-30T09:00:00.000Z'),
    });

    expect(aggregated['gemini-flash-lite']).toMatchObject({
      percentage: 7,
      resetTime: '2026-07-30T09:00:00.000Z',
    });
  });

  it('keeps unknown models, including names containing thinking', () => {
    const aggregated = aggregateQuotaModelFamilies({
      'vendor-experimental-thinking-v9': quota(23, 'not-a-date'),
    });

    expect(aggregated).toEqual({
      'vendor-experimental-thinking-v9': quota(23, 'not-a-date'),
    });
  });

  it('does not merge independently routed Claude families', () => {
    expect(getQuotaModelFamilyId('claude-sonnet-4-6-thinking')).toBe('claude-sonnet-4-6');
    expect(getQuotaModelFamilyId('claude-opus-4-6-thinking')).toBe('claude-opus-4-6');
  });

  it('keeps hidden routed members in the conservative family value', () => {
    const aggregated = aggregateVisibleQuotaModelFamilies(
      {
        'gemini-3.1-pro-low': quota(5, '2026-07-30T08:00:00.000Z'),
        'gemini-pro-agent': quota(80, '2026-07-30T10:00:00.000Z'),
      },
      {
        'gemini-3.1-pro-low': false,
      },
    );

    expect(aggregated['gemini-3.1-pro'].percentage).toBe(5);
  });
});
