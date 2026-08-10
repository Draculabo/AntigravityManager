import { describe, expect, it, vi } from 'vitest';
import { GenerationConstraintsService } from '@/modules/proxy-gateway/server/shared/services/generation-constraints.service';
import type { GeminiInternalRequest } from '@/modules/proxy-gateway/antigravity/types';

function createPolicy(overrides?: {
  outputLimit?: number;
  thinkingBudget?: number;
}): GenerationConstraintsService {
  return new GenerationConstraintsService({
    getModelOutputLimitForAccount: vi.fn().mockReturnValue(overrides?.outputLimit),
    getModelThinkingBudgetForAccount: vi.fn().mockReturnValue(overrides?.thinkingBudget),
  });
}

function createInternalRequest(generationConfig: Record<string, unknown>): GeminiInternalRequest {
  return {
    requestId: 'agent/1/test',
    request: {
      contents: [],
      generationConfig,
    },
    model: 'gemini-2.5-flash',
    userAgent: 'test-agent',
    requestType: 'generate-content',
  } as unknown as GeminiInternalRequest;
}

describe('GenerationConstraintsService', () => {
  it('keeps registered variant parameters authoritative over legacy model constraints', () => {
    const policy = createPolicy({
      outputLimit: 64_000,
      thinkingBudget: 32_768,
    });
    const request = createInternalRequest({
      maxOutputTokens: 64_000,
      stopSequences: ['Human:'],
      thinkingConfig: {
        includeThoughts: true,
        thinkingBudget: 1024,
      },
    });

    policy.applyInternalGenerationConstraints(request, 'claude-opus-4-6-thinking', 'acc-1', {
      thinkingBudget: 1024,
      maxOutputTokens: 64_000,
      includeThoughts: true,
    });

    expect(request.request.generationConfig).toEqual({
      maxOutputTokens: 64_000,
      stopSequences: ['Human:'],
      thinkingConfig: {
        includeThoughts: true,
        thinkingBudget: 1024,
      },
    });
  });

  it('converts Gemini thinking levels into budgets and reserves output tokens', () => {
    const policy = createPolicy({
      outputLimit: 20_000,
      thinkingBudget: 10_000,
    });
    const request = createInternalRequest({
      thinkingConfig: {
        thinkingLevel: 'medium',
      },
    });

    policy.applyInternalGenerationConstraints(request, 'gemini-2.5-flash', 'acc-1');

    expect(request.request.generationConfig?.thinkingConfig).toEqual({
      thinkingBudget: 8192,
    });
    expect(request.request.generationConfig?.maxOutputTokens).toBe(20_000);
  });

  it('caps negative adaptive thinking budgets by model thinking budget and output capacity', () => {
    const policy = createPolicy({
      outputLimit: 12_000,
      thinkingBudget: 8_000,
    });
    const request = createInternalRequest({
      thinkingConfig: {
        thinkingBudget: -1,
      },
    });

    policy.applyInternalGenerationConstraints(request, 'models/gemini-2.5-flash', 'acc-1');

    expect(request.request.generationConfig?.thinkingConfig).toEqual({
      thinkingBudget: 8000,
    });
    expect(request.request.generationConfig?.maxOutputTokens).toBe(12_000);
  });

  it('caps explicit max output tokens by account model output limit', () => {
    const policy = createPolicy({
      outputLimit: 4096,
      thinkingBudget: 1024,
    });
    const request = createInternalRequest({
      maxOutputTokens: 8192.9,
    });

    policy.applyInternalGenerationConstraints(request, 'gemini-2.5-flash', 'acc-1');

    expect(request.request.generationConfig?.maxOutputTokens).toBe(4096);
  });

  it('keeps Claude thinking level untouched while still capping output tokens', () => {
    const policy = createPolicy({
      outputLimit: 9000,
      thinkingBudget: 5000,
    });
    const request = createInternalRequest({
      maxOutputTokens: 12_000,
      thinkingConfig: {
        thinkingLevel: 'high',
      },
    });

    policy.applyInternalGenerationConstraints(request, 'claude-sonnet-4-5', 'acc-1');

    expect(request.request.generationConfig?.thinkingConfig).toEqual({
      thinkingLevel: 'high',
    });
    expect(request.request.generationConfig?.maxOutputTokens).toBe(9000);
  });

  it('enforces the verified Opus 4.6 thinking recipe and removes stop sequences', () => {
    const policy = createPolicy({
      outputLimit: 64_000,
      thinkingBudget: 32_768,
    });
    const request = createInternalRequest({
      maxOutputTokens: 4096,
      stopSequences: ['Human:'],
      thinkingConfig: {
        thinkingLevel: 'high',
        thinkingBudget: 32_768,
      },
    });

    policy.applyInternalGenerationConstraints(request, 'claude-opus-4-6-thinking', 'acc-1');

    expect(request.request.generationConfig).toEqual({
      maxOutputTokens: 57_344,
      thinkingConfig: {
        includeThoughts: true,
        thinkingBudget: 24_576,
      },
    });
  });

  it('caps the Opus 4.6 recipe by account capabilities', () => {
    const policy = createPolicy({
      outputLimit: 20_000,
      thinkingBudget: 12_000,
    });
    const request = createInternalRequest({
      thinkingConfig: {
        thinkingBudget: 24_576,
      },
    });

    policy.applyInternalGenerationConstraints(request, 'models/claude-opus-4-6-thinking', 'acc-1');

    expect(request.request.generationConfig).toEqual({
      maxOutputTokens: 20_000,
      thinkingConfig: {
        includeThoughts: true,
        thinkingBudget: 12_000,
      },
    });
  });
});
