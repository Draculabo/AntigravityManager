import { describe, expect, it } from 'vitest';

import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import type { ClaudeRequest } from '@/modules/proxy-gateway/antigravity/types';

describe('ClaudeRequestMapper Markdown image compatibility', () => {
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
});
