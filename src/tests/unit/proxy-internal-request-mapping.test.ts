import { describe, expect, it } from 'vitest';

import { ProxyService } from '@/modules/proxy-gateway/server/proxy.service';
import type { GeminiRequest } from '@/modules/proxy-gateway/server/interfaces/request-interfaces';
import type { GeminiInternalRequest } from '@/modules/proxy-gateway/antigravity/types';

function toInternalRequest(request: GeminiRequest): GeminiInternalRequest['request'] {
  const service = new ProxyService({} as never, {} as never);
  const method: unknown = Reflect.get(service, 'toInternalGeminiRequest');
  if (typeof method !== 'function') {
    throw new Error('toInternalGeminiRequest is unavailable');
  }
  return Reflect.apply(method, service, [request]) as GeminiInternalRequest['request'];
}

describe('toInternalGeminiRequest', () => {
  it('forwards tool declarations so the /v1beta passthrough can call tools', () => {
    const tools = [
      {
        functionDeclarations: [
          {
            name: 'get_weather',
            description: 'Look up the weather for a city',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        ],
      },
    ];

    const internal = toInternalRequest({
      contents: [{ role: 'user', parts: [{ text: 'weather in Berlin?' }] }],
      tools,
    } as GeminiRequest);

    expect(internal.tools).toEqual(tools);
  });

  it('leaves tools undefined when the caller sent none', () => {
    const internal = toInternalRequest({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });

    expect(internal.tools).toBeUndefined();
  });

  it('still maps contents, generationConfig and text-only systemInstruction', () => {
    const internal = toInternalRequest({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      generationConfig: { temperature: 0.25, maxOutputTokens: 64 },
      systemInstruction: { parts: [{ text: 'be brief' }, { inlineData: {} } as never] },
    } as GeminiRequest);

    expect(internal.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
    expect(internal.generationConfig).toEqual({ temperature: 0.25, maxOutputTokens: 64 });
    expect(internal.systemInstruction).toEqual({ parts: [{ text: 'be brief' }] });
  });
});
