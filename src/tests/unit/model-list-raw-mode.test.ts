import { describe, expect, it } from 'vitest';

import {
  getAllDynamicModels,
  getOpenAICompatibleModels,
} from '@/modules/proxy-gateway/antigravity/ModelMapping';

describe('raw quota model listing', () => {
  const customMapping = {
    'gpt-4o': 'gemini-3-flash',
  };

  it('returns the physical quota model set without retired IDs', () => {
    const quotaModels = [
      'gemini-3-pro-image',
      'gemini-2.5-flash',
      'gemini-pro-agent',
      'models/GEMINI-3.1-PRO-HIGH',
      'gemini-3-pro-image',
    ];

    expect(getAllDynamicModels(customMapping, quotaModels, true)).toEqual([
      'gemini-2.5-flash',
      'gemini-3-pro-image',
    ]);
  });

  it('keeps physical image models visible on the OpenAI endpoint', () => {
    const quotaModels = new Set(['gemini-3-flash', 'gemini-3-pro-image']);

    expect(getOpenAICompatibleModels(customMapping, quotaModels, true)).toEqual([
      'gemini-3-flash',
      'gemini-3-pro-image',
    ]);
  });

  it('returns an empty array before quota cache data is available', () => {
    expect(getAllDynamicModels(customMapping, undefined, true)).toEqual([]);
    expect(getOpenAICompatibleModels(customMapping, undefined, true)).toEqual([]);
  });
});
