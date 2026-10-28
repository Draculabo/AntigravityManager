import { describe, expect, it } from 'vitest';
import {
  getContextWindow,
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

describe('model context windows', () => {
  it.each([
    ['gemini-3.7-flash-low', 1_000_000],
    ['gemini-3.5-flash-high', 1_048_576],
    ['gemini-3-pro-image', 1_048_576],
    ['claude-sonnet-4-6', 200_000],
    ['claude-opus-4-6-thinking', 200_000],
    ['gpt-oss-120b-medium', 131_072],
  ] as const)('publishes the registered window for %s', (model, expected) => {
    expect(getContextWindow(model)).toBe(expected);
  });

  it.each([
    ['gemini-3.8-flash-high', 1_048_576],
    ['claude-opus-5-5-low', 200_000],
    ['unregistered-model', 128_000],
  ] as const)('falls back by family for the dynamic route %s', (model, expected) => {
    expect(getContextWindow(model)).toBe(expected);
  });
});
