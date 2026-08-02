import { describe, expect, it } from 'vitest';
import {
  rebindModelVariant,
  resolveModelVariant,
} from '@/modules/proxy-gateway/antigravity/model-variant-registry';

describe('resolveModelVariant', () => {
  it('defaults the canonical Gemini 3.5 Flash model to the registered high tier', () => {
    expect(resolveModelVariant({ model: 'gemini-3.5-flash' })).toEqual({
      canonicalModel: 'gemini-3.5-flash',
      model: 'gemini-3-flash-agent',
      tier: 'high',
      thinkingBudget: 10000,
      maxOutputTokens: 65536,
      includeThoughts: true,
      preserveClientBudget: false,
      supportsTools: true,
    });
  });

  it('uses the registered Gemini 3.5 Flash tier at each budget boundary', () => {
    expect(
      [1999, 2000, 6999, 7000].map((budgetTokens) =>
        resolveModelVariant({ model: 'gemini-3.5-flash', budgetTokens }),
      ),
    ).toEqual([
      {
        canonicalModel: 'gemini-3.5-flash',
        model: 'gemini-3.5-flash-extra-low',
        tier: 'low',
        thinkingBudget: 1000,
        maxOutputTokens: 65536,
        includeThoughts: true,
        preserveClientBudget: false,
        supportsTools: true,
      },
      {
        canonicalModel: 'gemini-3.5-flash',
        model: 'gemini-3.5-flash-low',
        tier: 'medium',
        thinkingBudget: 4000,
        maxOutputTokens: 65536,
        includeThoughts: true,
        preserveClientBudget: false,
        supportsTools: true,
      },
      {
        canonicalModel: 'gemini-3.5-flash',
        model: 'gemini-3.5-flash-low',
        tier: 'medium',
        thinkingBudget: 4000,
        maxOutputTokens: 65536,
        includeThoughts: true,
        preserveClientBudget: false,
        supportsTools: true,
      },
      {
        canonicalModel: 'gemini-3.5-flash',
        model: 'gemini-3-flash-agent',
        tier: 'high',
        thinkingBudget: 10000,
        maxOutputTokens: 65536,
        includeThoughts: true,
        preserveClientBudget: false,
        supportsTools: true,
      },
    ]);
  });

  it('prefers a supported Anthropic effort over the client budget', () => {
    expect(
      resolveModelVariant({
        model: 'gemini-3.5-flash',
        budgetTokens: 1000,
        effort: 'high',
      }),
    ).toEqual({
      canonicalModel: 'gemini-3.5-flash',
      model: 'gemini-3-flash-agent',
      tier: 'high',
      thinkingBudget: 10000,
      maxOutputTokens: 65536,
      includeThoughts: true,
      preserveClientBudget: false,
      supportsTools: true,
    });
  });

  it('uses the exact registered Gemini 3.1 Pro limits for low and high', () => {
    expect([
      resolveModelVariant({ model: 'gemini-3.1-pro', effort: 'low' }),
      resolveModelVariant({ model: 'gemini-3.1-pro', effort: 'high' }),
    ]).toEqual([
      {
        canonicalModel: 'gemini-3.1-pro',
        model: 'gemini-3.1-pro-low',
        tier: 'low',
        thinkingBudget: 1001,
        maxOutputTokens: 65535,
        includeThoughts: true,
        preserveClientBudget: false,
        supportsTools: true,
      },
      {
        canonicalModel: 'gemini-3.1-pro',
        model: 'gemini-pro-agent',
        tier: 'high',
        thinkingBudget: 10001,
        maxOutputTokens: 65535,
        includeThoughts: true,
        preserveClientBudget: false,
        supportsTools: true,
      },
    ]);
  });

  it('applies fixed and tier-aware alias policies', () => {
    expect(
      [
        resolveModelVariant({
          model: 'gemini-3.5-flash-low',
          effort: 'high',
        }),
        resolveModelVariant({
          model: 'gemini-3-flash',
          effort: 'medium',
        }),
        resolveModelVariant({
          model: 'gemini-3.1-pro-high',
          effort: 'low',
        }),
      ].map((variant) => ({
        canonicalModel: variant?.canonicalModel,
        model: variant?.model,
        tier: variant?.tier,
        thinkingBudget: variant?.thinkingBudget,
      })),
    ).toEqual([
      {
        canonicalModel: 'gemini-3.5-flash',
        model: 'gemini-3.5-flash-extra-low',
        tier: 'low',
        thinkingBudget: 1000,
      },
      {
        canonicalModel: 'gemini-3.5-flash',
        model: 'gemini-3.5-flash-low',
        tier: 'medium',
        thinkingBudget: 4000,
      },
      {
        canonicalModel: 'gemini-3.1-pro',
        model: 'gemini-3.1-pro-low',
        tier: 'low',
        thinkingBudget: 1001,
      },
    ]);
  });

  it('resolves registered non-variant models with their exact request policy', () => {
    expect([
      resolveModelVariant({
        model: 'gemini-2.5-flash-thinking',
        budgetTokens: 12000,
      }),
      resolveModelVariant({
        model: 'claude-opus-4-6',
        budgetTokens: 32768,
      }),
      resolveModelVariant({
        model: 'gpt-oss-120b-medium',
        budgetTokens: 1000,
      }),
    ]).toEqual([
      {
        canonicalModel: 'gemini-3.1-flash-lite',
        model: 'gemini-3.1-flash-lite',
        tier: 'high',
        thinkingBudget: 0,
        maxOutputTokens: 16384,
        includeThoughts: false,
        preserveClientBudget: false,
        supportsTools: false,
      },
      {
        canonicalModel: 'claude-opus-4-6-thinking',
        model: 'claude-opus-4-6-thinking',
        tier: 'high',
        thinkingBudget: 32768,
        maxOutputTokens: 64000,
        includeThoughts: true,
        preserveClientBudget: true,
        supportsTools: true,
      },
      {
        canonicalModel: 'gpt-oss-120b-medium',
        model: 'gpt-oss-120b-medium',
        tier: 'low',
        thinkingBudget: 8192,
        maxOutputTokens: 32768,
        includeThoughts: true,
        preserveClientBudget: false,
        supportsTools: true,
      },
    ]);
  });

  it('uses the registered Claude fallback budget when the client omits one', () => {
    expect(resolveModelVariant({ model: 'claude-sonnet-4-6' })).toEqual({
      canonicalModel: 'claude-sonnet-4-6',
      model: 'claude-sonnet-4-6',
      tier: 'high',
      thinkingBudget: 1024,
      maxOutputTokens: 64000,
      includeThoughts: true,
      preserveClientBudget: true,
      supportsTools: true,
    });
  });

  it('rebinds all registered parameters when account availability forces a different tier', () => {
    const low = resolveModelVariant({
      model: 'gemini-3.1-pro',
      effort: 'low',
    });

    expect(rebindModelVariant(low, 'gemini-pro-agent')).toEqual({
      canonicalModel: 'gemini-3.1-pro',
      model: 'gemini-pro-agent',
      tier: 'high',
      thinkingBudget: 10001,
      maxOutputTokens: 65535,
      includeThoughts: true,
      preserveClientBudget: false,
      supportsTools: true,
    });
  });
});
