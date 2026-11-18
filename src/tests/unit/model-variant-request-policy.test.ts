import { describe, expect, it } from 'vitest';
import {
  applyAnthropicModelVariant,
  applyGeminiModelVariant,
  applyOpenAIModelVariant,
  rebindAnthropicModelVariant,
  rebindGeminiModelVariant,
  rebindOpenAIModelVariant,
  resolveOpenAIRoutingEffort,
} from '@/server/gateway/shared/services/model-variant-request.service';
import type {
  AnthropicChatRequest,
  GeminiRequest,
  OpenAIChatRequest,
} from '@/server/gateway/common/interfaces/request-interfaces';

const proAgentRecipe = {
  canonicalModel: 'gemini-3.5-flash',
  model: 'gemini-3-flash-agent',
  tier: 'high',
  thinkingBudget: 10000,
  maxOutputTokens: 65536,
  includeThoughts: true,
  preserveClientBudget: false,
  supportsTools: true,
};

describe('applyGeminiModelVariant', () => {
  it('rejects an unknown Gemini thinking level before sanitizing the request', () => {
    const request = {
      contents: [],
      generationConfig: {
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: 'not-a-tier',
        },
      },
    };

    expect(() => applyGeminiModelVariant('gemini-3.7-flash', request)).toThrow(
      'Unsupported model effort "not-a-tier"',
    );
    expect(request.generationConfig.thinkingConfig.thinkingLevel).toBe('not-a-tier');
  });

  const request: GeminiRequest = {
    contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
  };

  it('resolves a canonical Gemini request to the default high physical variant', () => {
    expect(applyGeminiModelVariant('gemini-3.7-flash', request)).toEqual({
      model: 'gemini-3.7-flash-high',
      request,
      variant: {
        canonicalModel: 'gemini-3.7-flash',
        model: 'gemini-3.7-flash-high',
        tier: 'high',
        thinkingBudget: 10000,
        maxOutputTokens: 65536,
        includeThoughts: true,
        preserveClientBudget: false,
        supportsTools: true,
      },
    });
  });

  it('keeps the server-authoritative high variant for a tier-aware 3.6 alias', () => {
    const tieredRequest: GeminiRequest = {
      ...request,
      generationConfig: {
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: 1000,
        },
      },
    };

    const applied = applyGeminiModelVariant('gemini-3.6-flash-high', tieredRequest);

    expect(applied).toEqual({
      model: 'gemini-3.7-flash-high',
      request,
      variant: {
        canonicalModel: 'gemini-3.7-flash',
        model: 'gemini-3.7-flash-high',
        tier: 'high',
        thinkingBudget: 10000,
        maxOutputTokens: 65536,
        includeThoughts: true,
        preserveClientBudget: false,
        supportsTools: true,
      },
    });
    expect(tieredRequest.generationConfig?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: 1000,
    });
  });

  it('does not let a native thinking level downshift a Gemini 3 profile', () => {
    const tieredRequest: GeminiRequest = {
      ...request,
      generationConfig: {
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: 'medium',
        },
      },
    };

    const applied = applyGeminiModelVariant('gemini-3.7-flash', tieredRequest);

    expect(applied.variant).toEqual({
      canonicalModel: 'gemini-3.7-flash',
      model: 'gemini-3.7-flash-high',
      tier: 'high',
      thinkingBudget: 10000,
      maxOutputTokens: 65536,
      includeThoughts: true,
      preserveClientBudget: false,
      supportsTools: true,
    });
    expect(applied.request.generationConfig).toBeUndefined();
  });

  it('removes raw thinking controls from a direct Gemini agent request before forwarding it', () => {
    const directRequest: GeminiRequest = {
      ...request,
      generationConfig: {
        temperature: 0.2,
        thinkingConfig: {
          includeThoughts: false,
          thinkingBudget: 1000,
          thinkingLevel: 'low',
        },
      },
    };

    expect(applyGeminiModelVariant('gemini-3-flash-agent', directRequest)).toEqual({
      model: 'gemini-3-flash-agent',
      request: {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        generationConfig: { temperature: 0.2 },
      },
      variant: proAgentRecipe,
    });
    expect(directRequest.generationConfig?.thinkingConfig).toEqual({
      includeThoughts: false,
      thinkingBudget: 1000,
      thinkingLevel: 'low',
    });
  });

  it('rebinds the complete native variant tuple when an account selects a sibling', () => {
    const applied = applyGeminiModelVariant('gemini-3.7-flash-low', request);

    expect(rebindGeminiModelVariant(applied, 'gemini-3.7-flash-medium')).toEqual({
      model: 'gemini-3.7-flash-medium',
      request,
      variant: {
        canonicalModel: 'gemini-3.7-flash',
        model: 'gemini-3.7-flash-medium',
        tier: 'medium',
        thinkingBudget: 4000,
        maxOutputTokens: 65536,
        includeThoughts: true,
        preserveClientBudget: false,
        supportsTools: true,
      },
    });
  });
});

describe('applyAnthropicModelVariant', () => {
  it('rejects an unknown Anthropic output effort before sanitizing the request', () => {
    const request = {
      messages: [],
      model: 'claude-sonnet-4-6',
      output_config: { effort: 'not-a-tier' },
      thinking: { budget_tokens: 1024, type: 'enabled' },
    };

    expect(() => applyAnthropicModelVariant(request)).toThrow(
      'Unsupported model effort "not-a-tier"',
    );
    expect(request.thinking.budget_tokens).toBe(1024);
  });

  it('applies Anthropic effort before forwarding a canonical Gemini request', () => {
    const request: AnthropicChatRequest = {
      model: 'gemini-3.5-flash',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 2048,
      thinking: {
        type: 'enabled',
        budget_tokens: 1000,
      },
      output_config: {
        effort: 'high',
      },
    };

    expect(applyAnthropicModelVariant(request)).toEqual({
      request: {
        model: 'gemini-3-flash-agent',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 2048,
        thinking: {
          type: 'enabled',
          budget_tokens: 10000,
        },
        output_config: undefined,
        tools: undefined,
        tool_choice: undefined,
      },
      variant: {
        canonicalModel: 'gemini-3.5-flash',
        model: 'gemini-3-flash-agent',
        tier: 'high',
        thinkingBudget: 10000,
        maxOutputTokens: 65536,
        includeThoughts: true,
        preserveClientBudget: false,
        supportsTools: true,
      },
    });
    expect(request.model).toBe('gemini-3.5-flash');
  });

  it('does not let a raw Anthropic thinking budget downshift a Gemini 3 profile', () => {
    const applied = applyAnthropicModelVariant({
      model: 'gemini-3.5-flash',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 2048,
      thinking: {
        type: 'enabled',
        budget_tokens: 1000,
      },
    });

    expect(applied.request).toEqual({
      model: 'gemini-3-flash-agent',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 2048,
      thinking: {
        type: 'enabled',
        budget_tokens: 10000,
      },
      tools: undefined,
      tool_choice: undefined,
      output_config: undefined,
    });
    expect(applied.variant?.tier).toBe('high');
  });

  it('does not let Anthropic effort downshift an explicit Gemini 3 tier', () => {
    const applied = applyAnthropicModelVariant({
      model: 'gemini-3.5-flash-high',
      messages: [{ role: 'user', content: 'Hello' }],
      thinking: {
        type: 'enabled',
        budget_tokens: 1000,
      },
      output_config: {
        effort: 'low',
      },
    });

    expect(applied.request).toMatchObject({
      model: 'gemini-3-flash-agent',
      thinking: {
        type: 'enabled',
        budget_tokens: 10000,
      },
      output_config: undefined,
    });
    expect(applied.request).not.toHaveProperty('max_tokens');
    expect(applied.variant?.tier).toBe('high');
  });

  it('removes raw Anthropic thinking controls from a direct Gemini agent request', () => {
    const applied = applyAnthropicModelVariant({
      model: 'gemini-3-flash-agent',
      messages: [{ role: 'user', content: 'Hello' }],
      thinking: {
        type: 'enabled',
        budget_tokens: 1000,
      },
    });

    expect(applied).toEqual({
      request: {
        model: 'gemini-3-flash-agent',
        messages: [{ role: 'user', content: 'Hello' }],
        thinking: {
          type: 'enabled',
          budget_tokens: 10000,
        },
        output_config: undefined,
        tools: undefined,
        tool_choice: undefined,
      },
      variant: proAgentRecipe,
    });
  });

  it('preserves tools for Gemini 3.1 Flash-Lite while removing unsupported thinking controls', () => {
    const request: AnthropicChatRequest = {
      model: 'gemini-3.1-flash-lite',
      messages: [{ role: 'user', content: 'Use the tool' }],
      tools: [
        {
          name: 'lookup',
          input_schema: {
            type: 'object',
          },
        },
      ],
      tool_choice: {
        type: 'tool',
        name: 'lookup',
      },
      thinking: {
        type: 'enabled',
        budget_tokens: 8192,
      },
    };

    expect(applyAnthropicModelVariant(request).request).toEqual({
      model: 'gemini-3.1-flash-lite',
      messages: [{ role: 'user', content: 'Use the tool' }],
      tools: [
        {
          name: 'lookup',
          input_schema: {
            type: 'object',
          },
        },
      ],
      tool_choice: {
        type: 'tool',
        name: 'lookup',
      },
      thinking: undefined,
      output_config: undefined,
    });
  });

  it('updates the complete Anthropic request when an account requires a different registered tier', () => {
    const applied = applyAnthropicModelVariant({
      model: 'gemini-3.5-flash',
      messages: [{ role: 'user', content: 'Hello' }],
      output_config: {
        effort: 'low',
      },
    });

    expect(rebindAnthropicModelVariant(applied, 'gemini-3-flash-agent').request).toEqual({
      model: 'gemini-3-flash-agent',
      messages: [{ role: 'user', content: 'Hello' }],
      output_config: undefined,
      thinking: {
        type: 'enabled',
        budget_tokens: 10000,
      },
      tools: undefined,
      tool_choice: undefined,
    });
  });
});

describe('applyOpenAIModelVariant', () => {
  it.each(['reasoning_effort', 'reasoning.effort', 'thinking.effort'] as const)(
    'rejects an unknown OpenAI %s before sanitizing the request',
    (source) => {
      const originalThinking = {
        budget_tokens: 1000,
        type: 'enabled',
      };
      const controls =
        source === 'reasoning_effort'
          ? { reasoning_effort: 'not-a-tier' }
          : source === 'reasoning.effort'
            ? { reasoning: { effort: 'not-a-tier' } }
            : { thinking: { effort: 'not-a-tier' } };
      const request = {
        messages: [],
        model: 'gemini-3.8-flash',
        thinking: originalThinking,
        ...controls,
      };

      expect(() => applyOpenAIModelVariant(request)).toThrow(
        'Unsupported model effort "not-a-tier"',
      );
      expect(originalThinking).toEqual({
        budget_tokens: 1000,
        type: 'enabled',
      });
    },
  );

  it('uses the automatic Flash profile after selecting an advertised tiered route', () => {
    const applied = applyOpenAIModelVariant({
      model: 'gemini-3.7-flash',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    expect(rebindOpenAIModelVariant(applied, 'gemini-3.7-flash-tiered').request).toEqual({
      model: 'gemini-3.7-flash-tiered',
      messages: [{ role: 'user', content: 'Hello' }],
      thinking: { type: 'enabled', budget_tokens: -1 },
      tools: undefined,
      tool_choice: undefined,
    });
  });
  it('applies the registered model parameters and preserves tools', () => {
    const request: OpenAIChatRequest = {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'Use the tool' }],
      max_tokens: 4096,
      thinking: {
        type: 'enabled',
        budget_tokens: 12000,
      },
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup',
          },
        },
      ],
      tool_choice: 'required',
    };

    expect(applyOpenAIModelVariant(request).request).toEqual({
      model: 'gemini-3.1-flash-lite',
      messages: [{ role: 'user', content: 'Use the tool' }],
      max_tokens: 4096,
      thinking: undefined,
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup',
          },
        },
      ],
      tool_choice: 'required',
    });
  });

  it('lets an exact OpenAI reasoning_effort override the inferred budget tier', () => {
    const applied = applyOpenAIModelVariant({
      model: 'gemini-3.5-flash',
      messages: [],
      reasoning_effort: 'medium',
      thinking: {
        type: 'enabled',
        budget_tokens: 1000,
      },
    });

    expect(applied.request).toMatchObject({
      model: 'gemini-3.5-flash-low',
      thinking: {
        budget_tokens: 4000,
      },
    });
    expect(applied.request).not.toHaveProperty('max_tokens');
  });

  it('reads Responses reasoning.effort after the legacy effort field', () => {
    expect(
      resolveOpenAIRoutingEffort({
        model: 'gemini-3.5-flash',
        messages: [],
        reasoning_effort: 'high',
        reasoning: { effort: 'low' },
        thinking: { effort: 'medium' },
      }),
    ).toBe('high');
    expect(
      resolveOpenAIRoutingEffort({
        model: 'gemini-3.5-flash',
        messages: [],
        reasoning: { effort: 'low' },
        thinking: { effort: 'medium' },
      }),
    ).toBe('low');
    expect(
      resolveOpenAIRoutingEffort({
        model: 'gemini-3.5-flash',
        messages: [],
        thinking: { effort: 'medium' },
      }),
    ).toBe('medium');
  });

  it('applies and rebinds a Responses reasoning.effort tier', () => {
    const applied = applyOpenAIModelVariant({
      model: 'gemini-3.7-flash',
      messages: [],
      reasoning: { effort: 'low', max_tokens: 2048 },
    });

    expect(applied.request).toMatchObject({
      model: 'gemini-3.7-flash-low',
      reasoning: { effort: 'low', max_tokens: 2048 },
    });
    expect(rebindOpenAIModelVariant(applied, 'gemini-3.7-flash-high').request).toMatchObject({
      model: 'gemini-3.7-flash-high',
      reasoning: { effort: 'high', max_tokens: 2048 },
    });
  });

  it('does not let a raw OpenAI thinking budget downshift a Gemini 3 profile', () => {
    const applied = applyOpenAIModelVariant({
      model: 'gemini-3.7-flash',
      messages: [],
      thinking: {
        type: 'enabled',
        budget_tokens: 1000,
        effort: 'low',
      },
    });

    expect(applied.request).toMatchObject({
      model: 'gemini-3.7-flash-high',
      thinking: {
        budget_tokens: 10000,
      },
    });
    expect(applied.request).not.toHaveProperty('max_tokens');
    expect(applied.variant?.tier).toBe('high');
  });

  it('removes raw OpenAI thinking controls from a direct Gemini agent request', () => {
    const applied = applyOpenAIModelVariant({
      model: 'gemini-3-flash-agent',
      messages: [],
      reasoning_effort: 'medium',
      thinking: {
        type: 'enabled',
        budget_tokens: 1000,
        effort: 'low',
      },
    });

    expect(applied).toEqual({
      request: {
        model: 'gemini-3-flash-agent',
        messages: [],
        reasoning_effort: 'high',
        reasoning: undefined,
        thinking: { type: 'enabled', budget_tokens: 10000 },
        tools: undefined,
        tool_choice: undefined,
      },
      variant: proAgentRecipe,
    });
  });

  it('updates the complete OpenAI request when an account requires another registered tier', () => {
    const applied = applyOpenAIModelVariant({
      model: 'gemini-3.5-flash',
      messages: [{ role: 'user', content: 'Hello' }],
      thinking: {
        type: 'enabled',
        budget_tokens: 1000,
      },
    });

    expect(rebindOpenAIModelVariant(applied, 'gemini-3-flash-agent').request).toEqual({
      model: 'gemini-3-flash-agent',
      messages: [{ role: 'user', content: 'Hello' }],
      reasoning: undefined,
      thinking: {
        type: 'enabled',
        budget_tokens: 10000,
      },
      tools: undefined,
      tool_choice: undefined,
    });
  });
});
