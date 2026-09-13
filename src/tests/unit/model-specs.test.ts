import { describe, expect, it } from 'vitest';
import {
  getMaxOutputTokens,
  getThinkingBudget,
  resolveModelAlias,
} from '@/modules/proxy-gateway/antigravity/ModelSpecs';

describe('Gemini 3.7 model specs', () => {
  it.each([
    ['gemini-3.7-flash-low', 1000],
    ['gemini-3.7-flash-medium', 4000],
    ['gemini-3.7-flash-high', 10000],
  ] as const)('uses the registered output limit and budget for %s', (model, thinkingBudget) => {
    expect(getMaxOutputTokens(model)).toBe(65536);
    expect(getThinkingBudget(model)).toBe(thinkingBudget);
  });

  it.each([
    ['gemini-3.7-flash', 'gemini-3.7-flash-high'],
    ['gemini-3.7-flash-tiered', 'gemini-3.7-flash-high'],
    ['gemini-3.6-flash', 'gemini-3.7-flash-high'],
    ['gemini-3.6-flash-high', 'gemini-3.7-flash-high'],
    ['gemini-3.6-flash-medium', 'gemini-3.7-flash-medium'],
    ['gemini-3.6-flash-low', 'gemini-3.7-flash-low'],
  ] as const)('resolves compatibility spec %s to %s', (model, expected) => {
    expect(resolveModelAlias(model)).toBe(expected);
  });
});
