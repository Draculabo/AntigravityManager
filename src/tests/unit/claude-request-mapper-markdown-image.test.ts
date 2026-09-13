import { describe, expect, it } from 'vitest';

import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import type { ClaudeRequest } from '@/modules/proxy-gateway/antigravity/types';

describe('ClaudeRequestMapper Markdown image compatibility', () => {
  it('emits tool functionResponse before its inline image without fabricating text', () => {
    const request: ClaudeRequest = {
      model: 'gemini-3-flash',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_image',
              name: 'view_image',
              input: {},
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_image',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: 'AQ==',
                  },
                },
              ],
              is_error: false,
            },
          ],
        },
      ],
    };

    const body = transformClaudeRequestIn(request, 'project-a', 'test-agent');
    const toolParts = body.request.contents[1]?.parts;
    expect(toolParts).toEqual([
      {
        functionResponse: {
          name: 'view_image',
          response: { result: '' },
          id: 'call_image',
        },
      },
      { inlineData: { mimeType: 'image/png', data: 'AQ==' } },
    ]);
  });

  it('restores embedded Base64 Markdown images as native Gemini inlineData parts', () => {
    const request: ClaudeRequest = {
      model: 'gemini-3-flash',
      messages: [
        {
          role: 'user',
          content:
            'Before ![generated](data:image/png;base64,AAAABBBB) between ![photo](data:image/jpeg;base64,CCCCDDDD==) after',
        },
      ],
    };

    const body = transformClaudeRequestIn(request, 'project-a', 'test-agent');

    expect(body.request.contents).toEqual([
      {
        role: 'user',
        parts: [
          { text: 'Before ' },
          { inlineData: { mimeType: 'image/png', data: 'AAAABBBB' } },
          { text: ' between ' },
          { inlineData: { mimeType: 'image/jpeg', data: 'CCCCDDDD==' } },
          { text: ' after' },
        ],
      },
    ]);
  });

  it.each(['gemini-3-flash-image', 'gemini-3.1-flash-image', 'gemini-3.1-flash-image-16x9'])(
    'keeps Flash image requests on the verified Gemini 3.1 Flash image model for %s',
    (model) => {
      const request: ClaudeRequest = {
        model,
        messages: [
          {
            role: 'user',
            content: 'Generate a product photo.',
          },
        ],
      };

      const body = transformClaudeRequestIn(request);

      expect(body.model).toBe('gemini-3.1-flash-image');
      expect(body.request.generationConfig?.imageConfig).toEqual({
        aspectRatio: model.endsWith('-16x9') ? '16:9' : '1:1',
      });
    },
  );

  it('maps OpenAI image parameters into the Gemini image configuration', () => {
    const request: ClaudeRequest = {
      model: 'gemini-3.1-flash-image-1x1-2k',
      messages: [{ role: 'user', content: 'Generate a product photo.' }],
    };

    const body = transformClaudeRequestIn(request, undefined, undefined, undefined, 'openai', {
      imageRequest: {
        imageSize: '4K',
        quality: 'standard',
        size: '1280x720',
      },
    });

    expect(body.model).toBe('gemini-3.1-flash-image');
    expect(body.request.generationConfig?.imageConfig).toEqual({
      aspectRatio: '16:9',
      imageSize: '4K',
    });
    expect(body.request.safetySettings).toEqual([
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
    ]);
  });

  it('preserves an account-resolved image model while parsing config from the client model', () => {
    const request: ClaudeRequest = {
      model: 'gemini-3-pro-image-16x9-4k',
      messages: [{ role: 'user', content: 'Generate a product photo.' }],
    };

    const body = transformClaudeRequestIn(
      request,
      undefined,
      undefined,
      'gemini-3.1-pro-image',
      'openai',
    );

    expect(body.model).toBe('gemini-3.1-pro-image');
    expect(body.request.generationConfig?.imageConfig).toEqual({
      aspectRatio: '16:9',
      imageSize: '4K',
    });
  });

  it('does not alias an account-resolved legacy Flash image model', () => {
    const body = transformClaudeRequestIn(
      {
        model: 'gemini-3.1-flash-image-9x16-2k',
        messages: [{ role: 'user', content: 'Generate a portrait.' }],
      },
      undefined,
      undefined,
      'gemini-3-flash-image',
      'openai',
    );

    expect(body.model).toBe('gemini-3-flash-image');
    expect(body.request.generationConfig?.imageConfig).toEqual({
      aspectRatio: '9:16',
      imageSize: '2K',
    });
  });
});
