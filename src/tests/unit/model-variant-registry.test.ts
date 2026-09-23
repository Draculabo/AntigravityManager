import { describe, expect, it } from 'vitest';
import {
  rebindModelVariant,
  resolveModelVariant,
  usesAuthoritativeThinkingBudget,
} from '@/modules/proxy-gateway/antigravity/model-variant-registry';

describe('usesAuthoritativeThinkingBudget', () => {
  it('recognizes registered aliases, agent identities, future Gemini majors, and explicit tiers', () => {
    expect([
      usesAuthoritativeThinkingBudget('models/gemini-3.7-flash'),
      usesAuthoritativeThinkingBudget('gemini-pro'),
      usesAuthoritativeThinkingBudget('gemini-pro-agent'),
      usesAuthoritativeThinkingBudget('gemini-10-flash'),
      usesAuthoritativeThinkingBudget('gemini-3.8-flash-high'),
    ]).toEqual([true, true, true, true, true]);
  });

  it('does not classify pre-v3 or ordinary non-tiered non-Gemini models as authoritative', () => {
    expect([
      usesAuthoritativeThinkingBudget('gemini-2.5-flash'),
      usesAuthoritativeThinkingBudget('claude-sonnet-4-6'),
      usesAuthoritativeThinkingBudget('gpt-oss-120b-medium'),
    ]).toEqual([false, false, false]);
  });
});

describe('resolveModelVariant', () => {
  it('defaults the canonical Gemini 3.7 Flash model to the registered high tier', () => {
    expect(resolveModelVariant({ model: 'gemini-3.7-flash' })).toEqual({
      canonicalModel: 'gemini-3.7-flash',
      model: 'gemini-3.7-flash-high',
      tier: 'high',
      thinkingBudget: 10000,
      maxOutputTokens: 65536,
      includeThoughts: true,
      preserveClientBudget: false,
      supportsTools: true,
    });
  });

  it('honors explicit model tiers before effort or raw budgets', () => {
    expect([
      resolveModelVariant({ model: 'gemini-3.7-flash-low', effort: 'high' }),
      resolveModelVariant({ model: 'gemini-3.7-flash-medium', effort: 'low' }),
      resolveModelVariant({
        model: 'gemini-3.7-flash-high',
        effort: 'low',
        budgetTokens: 1000,
      }),
      resolveModelVariant({
        model: 'gemini-3.6-flash-high',
        effort: 'low',
        budgetTokens: 1000,
      }),
      resolveModelVariant({ model: 'gemini-3.6-flash-tiered', effort: 'medium' }),
    ]).toEqual([
      {
        canonicalModel: 'gemini-3.7-flash',
        model: 'gemini-3.7-flash-low',
        tier: 'low',
        thinkingBudget: 1000,
        maxOutputTokens: 65536,
        includeThoughts: true,
        preserveClientBudget: false,
        supportsTools: true,
      },
      {
        canonicalModel: 'gemini-3.7-flash',
        model: 'gemini-3.7-flash-medium',
        tier: 'medium',
        thinkingBudget: 4000,
        maxOutputTokens: 65536,
        includeThoughts: true,
        preserveClientBudget: false,
        supportsTools: true,
      },
      {
        canonicalModel: 'gemini-3.7-flash',
        model: 'gemini-3.7-flash-high',
        tier: 'high',
        thinkingBudget: 10000,
        maxOutputTokens: 65536,
        includeThoughts: true,
        preserveClientBudget: false,
        supportsTools: true,
      },
      {
        canonicalModel: 'gemini-3.7-flash',
        model: 'gemini-3.7-flash-high',
        tier: 'high',
        thinkingBudget: 10000,
        maxOutputTokens: 65536,
        includeThoughts: true,
        preserveClientBudget: false,
        supportsTools: true,
      },
      {
        canonicalModel: 'gemini-3.7-flash',
        model: 'gemini-3.7-flash-medium',
        tier: 'medium',
        thinkingBudget: 4000,
        maxOutputTokens: 65536,
        includeThoughts: true,
        preserveClientBudget: false,
        supportsTools: true,
      },
    ]);
  });

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

  it('applies explicit and tier-aware alias policies', () => {
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
        model: 'gemini-pro-agent',
        tier: 'high',
        thinkingBudget: 10001,
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
