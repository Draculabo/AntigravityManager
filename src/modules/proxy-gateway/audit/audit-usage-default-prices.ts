import type { UsagePrice } from './usage-overview.schema';

type TokenRates = [input: number, output: number, cachedInput: number];

function forModels(
  models: string[],
  [inputPerMillion, outputPerMillion, cachedPerMillion]: TokenRates,
) {
  return models.map((model) => ({ model, inputPerMillion, outputPerMillion, cachedPerMillion }));
}

/** Standard public API reference rates in USD per million tokens, verified November 25, 2026. */
export function resolveUsagePrices(overrides: UsagePrice[], asOf: number): UsagePrice[] {
  const defaults = [
    // No prefix matching. These gateway variants have the same public model and differ in thinking.
    // https://aistudio.google.com/docs/pricing#gemini-4-argon
    ...forModels(
      ['gemini-4-argon', 'gemini-4-argon-low', 'gemini-4-argon-medium', 'gemini-4-argon-high'],
      asOf < Date.UTC(2026, 11, 1) ? [2, 10, 0.1] : [4, 20, 0.2],
    ),
    // https://aistudio.google.com/docs/pricing#gemini-3.8-flash
    // https://cloud.google.com/model-garden/pricing
    ...forModels(
      [
        'gemini-3.8-flash',
        'gemini-3.8-flash-low',
        'gemini-3.8-flash-medium',
        'gemini-3.8-flash-high',
        'gemini-3.8-flash-tiered',
        'gemini-3.7-flash',
        'gemini-3.7-flash-low',
        'gemini-3.7-flash-medium',
        'gemini-3.7-flash-high',
        'gemini-3.7-flash-tiered',
        'gemini-3.6-flash',
        'gemini-3.6-flash-low',
        'gemini-3.6-flash-medium',
        'gemini-3.6-flash-high',
        'gemini-3.6-flash-tiered',
      ],
      asOf < Date.UTC(2027, 0, 1) ? [0.75, 3.75, 0.075] : [1.5, 7.5, 0.15],
    ),
    ...forModels(
      [
        'gemini-3.5-flash',
        'gemini-3.5-flash-extra-low',
        'gemini-3.5-flash-low',
        'gemini-3.5-flash-medium',
        'gemini-3.5-flash-high',
      ],
      [1.5, 9, 0.15],
    ),
    // Text and image input reference. Audio input has its own tariff.
    ...forModels(['gemini-3.1-flash-lite'], [0.25, 1.5, 0.025]),
    // https://platform.claude.com/docs/en/about-claude/pricing#model-pricing
    ...forModels(
      [
        'claude-opus-4-6',
        'claude-opus-4-6-thinking',
        'claude-opus-4-5',
        'claude-opus-4-5-thinking',
        'claude-opus-4-5-20251101',
      ],
      [5, 25, 0.5],
    ),
    ...forModels(
      [
        'claude-sonnet-4-6',
        'claude-sonnet-4-6-thinking',
        'claude-sonnet-4-5',
        'claude-sonnet-4-5-thinking',
        'claude-sonnet-4-5-20250929',
      ],
      [3, 15, 0.3],
    ),
    ...forModels(['claude-haiku-4-5', 'claude-haiku-4-5-20251001'], [1, 5, 0.1]),
  ];
  const overridden = new Set(overrides.map(({ model }) => model));
  return [...defaults.filter(({ model }) => !overridden.has(model)), ...overrides];
}
