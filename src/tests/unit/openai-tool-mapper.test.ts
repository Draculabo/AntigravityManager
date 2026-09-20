import { describe, expect, it } from 'vitest';

import { MISSING_COMMAND_FALLBACK } from '@/modules/proxy-gateway/antigravity/CommandToolAdapter';
import { OpenAIService as ProxyService } from '../../modules/proxy-gateway/server/modules/openai/openai.service';

describe('OpenAI tool mapper compatibility', () => {
  it('maps a Responses apply_patch custom tool to the upstream freeform input schema', () => {
    const service = Object.create(ProxyService.prototype) as ProxyService;
    const result = Reflect.get(service, 'convertOpenAIToolsToAnthropicTools').call(service, [
      {
        type: 'custom',
        name: 'apply_patch',
        description: 'Apply a patch.',
      },
    ]);

    expect(result).toEqual([
      {
        name: 'apply_patch',
        description: 'Apply a patch.',
        input_schema: {
          type: 'object',
          properties: {
            input: {
              type: 'string',
              description:
                'The exact freeform V4A patch text to pass to Codex apply_patch. It must start with *** Begin Patch and end with *** End Patch. Do not wrap it in a shell command or command array.',
            },
          },
          required: ['input'],
        },
      },
    ]);
  });

  it('treats safety prompt feedback as a usable upstream response', () => {
    const service = Object.create(ProxyService.prototype) as ProxyService;
    const hasUsableResponse = Reflect.get(service, 'hasUsableGeminiCandidate').call(service, {
      candidates: [],
      promptFeedback: {
        blockReason: 'SAFETY',
      },
    });

    expect(hasUsableResponse).toBe(true);
  });

  it('normalizes an incomplete PowerShell tool call in a non-stream Chat Completions response', () => {
    const service = Object.create(ProxyService.prototype) as ProxyService;
    const result = Reflect.get(service, 'convertClaudeToOpenAIResponse').call(
      service,
      {
        content: [
          {
            id: 'call_powershell',
            input: { description: 'sensitive tool detail' },
            name: 'PowerShell',
            type: 'tool_use',
          },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      'gpt-5-codex',
    );

    expect(result.choices[0]).toMatchObject({ finish_reason: 'tool_calls' });
    const toolCall = result.choices[0].message.tool_calls?.[0];
    expect(toolCall?.function?.name).toBe('PowerShell');
    expect(JSON.parse(toolCall?.function?.arguments ?? '{}')).toEqual({
      command: MISSING_COMMAND_FALLBACK,
      description: 'sensitive tool detail',
    });
  });
});
