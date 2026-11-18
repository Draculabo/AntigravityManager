import { describe, expect, it } from 'vitest';
import { resolveGenerationPlan } from '@/server/gateway/shared/generation-plan';

describe('resolveGenerationPlan', () => {
  it('keeps -1 as adaptive and does not treat 32768 as a sentinel', () => {
    expect(
      resolveGenerationPlan({
        source: 'gateway',
        model: 'gemini-3.7-flash',
        gatewayThinkingBudget: -1,
        outputCap: 65536,
        thinkingCap: 32768,
      }).thinking,
    ).toEqual({ kind: 'adaptive' });
    expect(
      resolveGenerationPlan({
        source: 'gateway',
        model: 'gemini-3.7-flash',
        gatewayThinkingBudget: 32768,
        explicitMaxOutputTokens: 65536,
        outputCap: 65536,
        thinkingCap: 65536,
      }).thinking,
    ).toEqual({ kind: 'budget', budget: 32768 });
  });

  it('gives client numeric budget precedence over effort and supports explicit disable', () => {
    expect(
      resolveGenerationPlan({
        source: 'client',
        model: 'claude-sonnet-4-6',
        clientBudget: 8000,
        clientEffort: 'low',
        outputCap: 16000,
        thinkingCap: 12000,
      }).thinking,
    ).toEqual({ kind: 'budget', budget: 8000 });
    expect(
      resolveGenerationPlan({
        source: 'client',
        model: 'claude-sonnet-4-6',
        clientDisabled: true,
        clientBudget: 8000,
        outputCap: 16000,
        thinkingCap: 12000,
      }).thinking,
    ).toEqual({ kind: 'disabled' });
  });

  it('applies the six-times rule to an explicit output limit', () => {
    const plan = resolveGenerationPlan({
      source: 'client',
      model: 'gemini-2.5-flash',
      clientBudget: 8192,
      explicitMaxOutputTokens: 1024,
      outputCap: 32768,
      thinkingCap: 16384,
    });
    expect(plan.maxOutputTokens).toBe(1024);
    expect(plan.thinking).toEqual({ kind: 'budget', budget: 0 });
  });

  it('constrains registered recipes by the current account capability', () => {
    const plan = resolveGenerationPlan({
      source: 'gateway',
      model: 'gemini-3.7-flash-high',
      registeredThinkingBudget: 10000,
      registeredMaxOutputTokens: 65536,
      outputCap: 4096,
      thinkingCap: 2048,
    });
    expect(plan.maxOutputTokens).toBe(3072);
    expect(plan.thinking).toEqual({ kind: 'budget', budget: 2048 });
  });

  it('derives the output limit from the budget when no limit was supplied', () => {
    const plan = resolveGenerationPlan({
      source: 'gateway',
      model: 'gemini-3-pro-high-thinking',
      registeredThinkingBudget: 10_001,
      outputCap: 65_535,
      thinkingCap: 10_001,
    });
    expect(plan.maxOutputTokens).toBe(11_025);
    expect(plan.thinking).toEqual({ kind: 'budget', budget: 10_001 });
    expect(plan.adjustmentReasons).toContain('output-derived-from-thinking-budget');
  });

  it('uses the smaller headroom when the caller supplied a limit below the budget', () => {
    const plan = resolveGenerationPlan({
      source: 'client',
      model: 'gemini-3-pro-high-thinking',
      clientBudget: 10_001,
      explicitMaxOutputTokens: 8_000,
      outputCap: 65_535,
      thinkingCap: 10_001,
    });
    expect(plan.maxOutputTokens).toBe(11_025);
    expect(plan.thinking).toEqual({ kind: 'budget', budget: 10_001 });
    expect(plan.adjustmentReasons).toContain('output-raised-for-thinking-budget');
  });
});
