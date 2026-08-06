import { describe, expect, it } from 'vitest';
import {
  applyAnthropicModelVariant,
  applyOpenAIModelVariant,
  rebindAnthropicModelVariant,
  rebindOpenAIModelVariant,
} from '@/modules/proxy-gateway/server/modules/shared/services/model-variant-request.service';
import type {
  AnthropicChatRequest,
  OpenAIChatRequest,
} from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';

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
