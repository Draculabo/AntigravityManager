import { describe, expect, it } from 'vitest';

import { ProxyService } from '../../modules/proxy-gateway/server/proxy.service';

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
});
