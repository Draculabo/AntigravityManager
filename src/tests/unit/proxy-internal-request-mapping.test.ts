import { describe, expect, it } from 'vitest';

import { toInternalGeminiRequest } from '@/modules/proxy-gateway/server/modules/gemini/gemini-request-envelope';
import type { GeminiRequest } from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';
import type { GeminiInternalRequest } from '@/modules/proxy-gateway/antigravity/types';

function toInternalRequest(
  request: GeminiRequest,
  model = 'gemini-3-flash',
): GeminiInternalRequest['request'] {
  return toInternalGeminiRequest(request, model);
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
    expect(internal.toolConfig).toEqual({
      functionCallingConfig: { mode: 'VALIDATED' },
      includeServerSideToolInvocations: true,
    });
  });

  it('preserves caller function selection while enabling server-side tool invocations', () => {
    const internal = toInternalRequest({
      contents: [{ role: 'user', parts: [{ text: 'weather in Berlin?' }] }],
      tools: [{ functionDeclarations: [{ name: 'get_weather' }] }],
      toolConfig: {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: ['get_weather'],
        },
      },
    } as GeminiRequest);

    expect(internal.toolConfig).toEqual({
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: ['get_weather'],
      },
      includeServerSideToolInvocations: true,
    });
  });

  it('leaves tools undefined when the caller sent none', () => {
    const internal = toInternalRequest({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });

    expect(internal.tools).toBeUndefined();
    expect(internal.toolConfig).toBeUndefined();
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

  it.each(['gemini-3.5-flash-high', 'gemini-3.6-flash', 'gemini-3.7-flash'])(
    'injects both sentinel signature fields into unsigned %s function calls',
    (model) => {
      const contents = [
        {
          role: 'model',
          parts: [{ functionCall: { name: 'get_weather', args: {}, id: 'call_weather' } }],
        },
      ];

      const internal = toInternalRequest({ contents } as GeminiRequest, model);

      expect(internal.contents).not.toBe(contents);
      expect(internal.contents[0]?.parts[0]).toEqual({
        functionCall: { name: 'get_weather', args: {}, id: 'call_weather' },
        thoughtSignature: 'skip_thought_signature_validator',
        thought_signature: 'skip_thought_signature_validator',
      });
    },
  );

  it('preserves real signatures and leaves unsigned non-Flash calls unchanged', () => {
    const realSignature = 'real-provider-signature';
    const signed = toInternalRequest(
      {
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: { name: 'signed_call', args: {} },
                thoughtSignature: realSignature,
              },
            ],
          },
        ],
      } as GeminiRequest,
      'gemini-3.5-flash-high',
    );
    const unsignedPro = toInternalRequest(
      {
        contents: [
          {
            role: 'model',
            parts: [{ functionCall: { name: 'unsigned_call', args: {} } }],
          },
        ],
      } as GeminiRequest,
      'gemini-3.1-pro-high',
    );

    expect(signed.contents[0]?.parts[0]).toEqual({
      functionCall: { name: 'signed_call', args: {} },
      thoughtSignature: realSignature,
      thought_signature: realSignature,
    });
    expect(unsignedPro.contents[0]?.parts[0]).toEqual({
      functionCall: { name: 'unsigned_call', args: {} },
    });
  });
});
