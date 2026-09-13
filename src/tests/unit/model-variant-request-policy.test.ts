import { describe, expect, it } from 'vitest';
import {
  applyAnthropicModelVariant,
  applyGeminiModelVariant,
  applyOpenAIModelVariant,
  rebindAnthropicModelVariant,
  rebindGeminiModelVariant,
  rebindOpenAIModelVariant,
} from '@/modules/proxy-gateway/server/shared/services/model-variant-request.service';
import type {
  AnthropicChatRequest,
  GeminiRequest,
  OpenAIChatRequest,
} from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';

describe('applyGeminiModelVariant', () => {
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

  it('honors an explicit native thinking budget for the tier-aware 3.6 high alias', () => {
    const tieredRequest: GeminiRequest = {
      ...request,
      generationConfig: {
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: 1000,
        },
      },
    };

    expect(applyGeminiModelVariant('gemini-3.6-flash-high', tieredRequest)).toEqual({
      model: 'gemini-3.7-flash-low',
      request: tieredRequest,
      variant: {
        canonicalModel: 'gemini-3.7-flash',
        model: 'gemini-3.7-flash-low',
        tier: 'low',
        thinkingBudget: 1000,
        maxOutputTokens: 65536,
        includeThoughts: true,
        preserveClientBudget: false,
        supportsTools: true,
      },
    });
  });

  it('uses a valid native thinking level as the explicit tier', () => {
    const tieredRequest: GeminiRequest = {
      ...request,
      generationConfig: {
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: 'medium',
        },
      },
    };

    expect(applyGeminiModelVariant('gemini-3.7-flash', tieredRequest).variant).toEqual({
      canonicalModel: 'gemini-3.7-flash',
      model: 'gemini-3.7-flash-medium',
      tier: 'medium',
      thinkingBudget: 4000,
      maxOutputTokens: 65536,
      includeThoughts: true,
      preserveClientBudget: false,
      supportsTools: true,
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
  it('applies Anthropic effort before forwarding a canonical Gemini request', () => {
    const request: AnthropicChatRequest = {
      model: 'gemini-3.1-pro',
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
        model: 'gemini-pro-agent',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 65535,
        thinking: {
          type: 'enabled',
          budget_tokens: 10001,
        },
        output_config: undefined,
      },
      variant: {
        canonicalModel: 'gemini-3.1-pro',
        model: 'gemini-pro-agent',
        tier: 'high',
        thinkingBudget: 10001,
        maxOutputTokens: 65535,
        includeThoughts: true,
        preserveClientBudget: false,
        supportsTools: true,
      },
    });
    expect(request.model).toBe('gemini-3.1-pro');
  });

  it('silently removes thinking and tool fields for a registered checkpoint without tool support', () => {
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
      tools: undefined,
      tool_choice: undefined,
      thinking: undefined,
      max_tokens: 16384,
      output_config: undefined,
    });
  });

  it('updates the complete Anthropic request when an account requires a different registered tier', () => {
    const applied = applyAnthropicModelVariant({
      model: 'gemini-3.1-pro',
      messages: [{ role: 'user', content: 'Hello' }],
      output_config: {
        effort: 'low',
      },
    });

    expect(rebindAnthropicModelVariant(applied, 'gemini-pro-agent').request).toEqual({
      model: 'gemini-pro-agent',
      messages: [{ role: 'user', content: 'Hello' }],
      output_config: undefined,
      max_tokens: 65535,
      thinking: {
        type: 'enabled',
        budget_tokens: 10001,
      },
      tools: undefined,
      tool_choice: undefined,
    });
  });
});

describe('applyOpenAIModelVariant', () => {
  it('applies the registered model parameters and silently strips unsupported tools', () => {
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
      max_tokens: 16384,
      thinking: undefined,
      tools: undefined,
      tool_choice: undefined,
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
      max_tokens: 65536,
      thinking: {
        budget_tokens: 4000,
      },
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
      max_tokens: 65536,
      thinking: {
        type: 'enabled',
        budget_tokens: 10000,
      },
      tools: undefined,
      tool_choice: undefined,
    });
  });
});
