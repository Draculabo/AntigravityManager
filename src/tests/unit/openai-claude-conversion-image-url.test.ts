import { describe, expect, it } from 'vitest';

import {
  convertOpenAIPartsToAnthropicContent,
  convertOpenAIToClaude,
} from '@/modules/proxy-gateway/server/modules/openai/chat/openai-claude-conversion';
import type { OpenAIContentPart } from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';

describe('OpenAI image URL conversion', () => {
  const imageUrls: ReadonlyArray<NonNullable<OpenAIContentPart['image_url']>> = [
    'data:image/png;base64,AA==',
    'data:image/png;BASE64,AA==',
    'data:image/webp;name=source;BASE64,AQ==',
    { url: 'data:image/png;base64,AA==', detail: 'high' },
  ];

  it.each(imageUrls)(
    'converts supported image URL form %# into an Anthropic image block',
    (imageUrl) => {
      const content = convertOpenAIPartsToAnthropicContent([
        {
          type: 'image_url',
          image_url: imageUrl,
        },
      ]);

      const dataUrl = typeof imageUrl === 'string' ? imageUrl : imageUrl.url;
      const expectedMime = dataUrl.includes('image/webp') ? 'image/webp' : 'image/png';
      const expectedData = dataUrl.endsWith('AQ==') ? 'AQ==' : 'AA==';
      expect(content).toEqual([
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: expectedMime,
            data: expectedData,
          },
        },
      ]);
    },
  );

  it('keeps tool-result text and image media in one ordered result payload', () => {
    const request = convertOpenAIToClaude({
      model: 'gemini-3-flash',
      messages: [
        {
          role: 'tool',
          tool_call_id: 'call_image',
          content: [
            { type: 'text', text: 'image generated' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==' } },
          ],
        },
      ],
    });

    expect(request.messages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_image',
            content: [
              { type: 'text', text: 'image generated' },
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
    ]);
  });

  it('maps audio_url data and remote URLs while keeping the tool fallback', () => {
    expect(
      convertOpenAIPartsToAnthropicContent([
        {
          type: 'audio_url',
          audio_url: { url: 'data:audio/wav;name=sample;base64,AQ==' },
        },
        {
          type: 'audio_url',
          audio_url: { url: 'https://example.com/sample.ogg' },
        },
      ]),
    ).toEqual([
      {
        type: 'audio',
        source: { type: 'base64', media_type: 'audio/wav', data: 'AQ==' },
      },
      {
        type: 'audio',
        source: {
          type: 'url',
          media_type: 'audio/ogg',
          url: 'https://example.com/sample.ogg',
        },
      },
    ]);

    const request = convertOpenAIToClaude({
      model: 'gemini-3-flash',
      messages: [
        {
          role: 'tool',
          tool_call_id: 'call_audio',
          content: [{ type: 'audio_url', audio_url: { url: 'not-a-readable-source' } }],
        },
      ],
    });
    expect(request.messages[0]?.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'call_audio',
        content: '[audio]',
        is_error: false,
      },
    ]);
  });

  it('keeps the tool-result fallback for a remote image link', () => {
    const request = convertOpenAIToClaude({
      model: 'gemini-3-flash',
      messages: [
        {
          role: 'tool',
          tool_call_id: 'call_image',
          content: [
            {
              type: 'image_url',
              image_url: { url: 'https://example.com/tool-output.png' },
            },
          ],
        },
      ],
    });

    expect(request.messages[0]?.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'call_image',
        content: '[image link]',
        is_error: false,
      },
    ]);
  });
});
