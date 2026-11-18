import { describe, expect, it } from 'vitest';
import { openAIMediaTask } from '@/server/gateway/common/session-media-anchor';
import {
  resolveAnthropicSessionScope,
  resolveGeminiSessionScope,
  resolveOpenAISessionScope,
} from '@/server/gateway/common/signature-session-scope';
import { buildResponsesChatRequest } from '@/server/gateway/modules/openai/responses/openai-responses-request';
import type {
  AnthropicChatRequest,
  AnthropicContent,
  GeminiPart,
  GeminiRequest,
  OpenAIChatRequest,
  OpenAIContentPart,
} from '@/server/gateway/common/interfaces/request-interfaces';

const headers = { authorization: 'Bearer synthetic-media-tenant', 'x-session-id': 'media-session' };
const audio = 'UklGRjAwMDBXQVZFZm10IA==';
const video = 'AAAAAQID';
const document = 'JVBERi0xLjQK';
const prompt = 'Analyze the media.';

function protocolScopes(
  openAIMedia: OpenAIContentPart,
  anthropicMedia: AnthropicContent,
  geminiMedia: GeminiPart,
) {
  const openAI: OpenAIChatRequest = {
    model: 'gemini-3-flash',
    messages: [
      { role: 'system', content: 'Read only.' },
      { role: 'user', content: [{ type: 'text', text: prompt }, openAIMedia] },
    ],
  };
  const anthropic: AnthropicChatRequest = {
    model: openAI.model,
    system: 'Read only.',
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, anthropicMedia] }],
  };
  const gemini: GeminiRequest = {
    systemInstruction: { parts: [{ text: 'Read only.' }] },
    contents: [{ role: 'user', parts: [{ text: prompt }, geminiMedia] }],
  };
  return [
    resolveOpenAISessionScope(openAI, headers),
    resolveAnthropicSessionScope(anthropic, headers),
    resolveGeminiSessionScope(gemini, headers),
  ];
}

describe('cross-protocol media session anchors', () => {
  it.each(['A', 'AAA', 'AA=A', '====', 'A===', 'AAAA\n'])(
    'does not assign an inline image identity to malformed Base64 %j',
    (data) => {
      expect(
        openAIMediaTask([{ type: 'image_url', image_url: `data:image/png;base64,${data}` }]),
      ).toBeUndefined();
    },
  );
  it('unifies equivalent inline audio across Chat, Messages and Gemini', () => {
    const scopes = protocolScopes(
      { type: 'input_audio', input_audio: { data: audio, format: 'x-wav' } },
      { type: 'audio', source: { type: 'base64', media_type: 'audio/wav', data: audio } },
      { inlineData: { mimeType: 'audio/wav', data: audio } },
    );

    expect(new Set(scopes.map((scope) => scope.storeKey)).size).toBe(1);
  });

  it('unifies equivalent inline video across Chat, Messages and Gemini', () => {
    const scopes = protocolScopes(
      { type: 'video_url', video_url: { url: `data:video/mp4;base64,${video}` } },
      { type: 'video', source: { type: 'base64', media_type: 'video/mp4', data: video } },
      { inlineData: { mimeType: 'video/mp4', data: video } },
    );

    expect(new Set(scopes.map((scope) => scope.storeKey)).size).toBe(1);
  });

  it('unifies supported Responses input_audio with the same initial task identity', () => {
    const openAI = buildResponsesChatRequest({
      model: 'gemini-3-flash',
      instructions: 'Read only.',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            { type: 'input_audio', input_audio: { data: audio, format: 'wav' } },
          ],
        },
      ],
    });
    const scopes = [
      resolveOpenAISessionScope(openAI, headers),
      ...protocolScopes(
        { type: 'input_audio', input_audio: { data: audio, format: 'wav' } },
        { type: 'audio', source: { type: 'base64', media_type: 'audio/wav', data: audio } },
        { inlineData: { mimeType: 'audio/wav', data: audio } },
      ),
    ];

    expect(new Set(scopes.map((scope) => scope.storeKey)).size).toBe(1);
  });

  it('unifies inline PDF documents between Messages and Gemini and preserves document titles', () => {
    const anthropic: AnthropicChatRequest = {
      model: 'gemini-3-flash',
      system: 'Read only.',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: document },
            },
          ],
        },
      ],
    };
    const gemini: GeminiRequest = {
      systemInstruction: { parts: [{ text: 'Read only.' }] },
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            { inlineData: { mimeType: 'application/pdf', data: document } },
          ],
        },
      ],
    };
    const sameTitle = resolveAnthropicSessionScope(anthropic, headers).storeKey;
    const differentTitle = resolveAnthropicSessionScope(
      {
        ...anthropic,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'document',
                title: 'Different source',
                source: { type: 'base64', media_type: 'application/pdf', data: document },
              },
            ],
          },
        ],
      },
      headers,
    ).storeKey;

    expect(sameTitle).toBe(resolveGeminiSessionScope(gemini, headers).storeKey);
    expect(differentTitle).not.toBe(sameTitle);
  });

  it.each([
    {
      name: 'audio',
      openAI: {
        type: 'audio_url',
        audio_url: { url: 'https://example.invalid/media/clip.wav', mime_type: 'audio/wav' },
      } satisfies OpenAIContentPart,
      anthropic: {
        type: 'audio',
        source: {
          type: 'url',
          media_type: 'audio/wav',
          url: 'https://example.invalid/media/clip.wav',
        },
      } satisfies AnthropicContent,
      gemini: {
        fileData: {
          fileUri: 'https://example.invalid/media/clip.wav',
          mimeType: 'audio/wav',
        },
      } satisfies GeminiPart,
    },
    {
      name: 'video',
      openAI: {
        type: 'video_url',
        video_url: { url: 'https://example.invalid/media/clip.mp4' },
      } satisfies OpenAIContentPart,
      anthropic: {
        type: 'video',
        source: {
          type: 'url',
          media_type: 'video/mp4',
          url: 'https://example.invalid/media/clip.mp4',
        },
      } satisfies AnthropicContent,
      gemini: {
        fileData: {
          fileUri: 'https://example.invalid/media/clip.mp4',
          mimeType: 'video/mp4',
        },
      } satisfies GeminiPart,
    },
  ])('unifies $name references without fetching the resource', ({ openAI, anthropic, gemini }) => {
    const scopes = protocolScopes(openAI, anthropic, gemini);
    expect(new Set(scopes.map((scope) => scope.storeKey)).size).toBe(1);
  });

  it('separates changed media bytes, MIME types and remote references', () => {
    const base = protocolScopes(
      { type: 'input_audio', input_audio: { data: audio, format: 'wav' } },
      { type: 'audio', source: { type: 'base64', media_type: 'audio/wav', data: audio } },
      { inlineData: { mimeType: 'audio/wav', data: audio } },
    );
    const changedBytes = protocolScopes(
      { type: 'input_audio', input_audio: { data: 'AQIDBA==', format: 'wav' } },
      { type: 'audio', source: { type: 'base64', media_type: 'audio/wav', data: 'AQIDBA==' } },
      { inlineData: { mimeType: 'audio/wav', data: 'AQIDBA==' } },
    );
    const changedMime = protocolScopes(
      { type: 'input_audio', input_audio: { data: audio, format: 'mp3' } },
      { type: 'audio', source: { type: 'base64', media_type: 'audio/mpeg', data: audio } },
      { inlineData: { mimeType: 'audio/mpeg', data: audio } },
    );
    const changedReference = protocolScopes(
      { type: 'audio_url', audio_url: { url: 'https://example.invalid/media/other.wav' } },
      {
        type: 'audio',
        source: {
          type: 'url',
          media_type: 'audio/wav',
          url: 'https://example.invalid/media/other.wav',
        },
      },
      {
        fileData: {
          fileUri: 'https://example.invalid/media/other.wav',
          mimeType: 'audio/wav',
        },
      },
    );

    expect(changedBytes[0]?.storeKey).not.toBe(base[0]?.storeKey);
    expect(changedMime[0]?.storeKey).not.toBe(base[0]?.storeKey);
    expect(changedReference[0]?.storeKey).not.toBe(
      protocolScopes(
        { type: 'audio_url', audio_url: { url: 'https://example.invalid/media/clip.wav' } },
        {
          type: 'audio',
          source: {
            type: 'url',
            media_type: 'audio/wav',
            url: 'https://example.invalid/media/clip.wav',
          },
        },
        {
          fileData: {
            fileUri: 'https://example.invalid/media/clip.wav',
            mimeType: 'audio/wav',
          },
        },
      )[0]?.storeKey,
    );
  });

  it('includes canonical MIME in remote media identity', () => {
    const audioScope = (mimeType?: string, url = 'https://example.invalid/media/clip.wav') =>
      resolveOpenAISessionScope(
        {
          model: 'gemini-3-flash',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'audio_url',
                  audio_url: {
                    url,
                    ...(mimeType ? { mime_type: mimeType } : {}),
                  },
                },
              ],
            },
          ],
        },
        headers,
      );
    const geminiVideoScope = (mimeType: string) =>
      resolveGeminiSessionScope(
        {
          contents: [
            {
              role: 'user',
              parts: [
                {
                  fileData: {
                    fileUri: 'https://example.invalid/media/clip.mp4',
                    mimeType,
                  },
                },
              ],
            },
          ],
        },
        headers,
      );

    expect(audioScope('audio/x-wav').storeKey).toBe(audioScope().storeKey);
    expect(
      audioScope('audio/wav', 'https://EXAMPLE.invalid:443/media/../media/clip.wav').storeKey,
    ).toBe(audioScope('audio/wav').storeKey);
    expect(audioScope('audio/mpeg').storeKey).not.toBe(audioScope('audio/wav').storeKey);
    expect(geminiVideoScope('video/webm').storeKey).not.toBe(
      geminiVideoScope('video/mp4').storeKey,
    );
  });

  it('keeps remote OpenAI images and unknown extensions protocol scoped', () => {
    const openAI: OpenAIChatRequest = {
      model: 'gemini-3-flash',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: 'https://example.invalid/media/image.png' },
          ],
        },
      ],
    };
    const gemini: GeminiRequest = {
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            {
              fileData: {
                fileUri: 'https://example.invalid/media/image.png',
                mimeType: 'image/png',
              },
            },
          ],
        },
      ],
    };
    const unknown: GeminiRequest = {
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            { fileData: { fileUri: 'C:\\media\\image.png', mimeType: 'image/png' } },
          ],
        },
      ],
    };

    expect(resolveOpenAISessionScope(openAI, headers).storeKey).not.toBe(
      resolveGeminiSessionScope(gemini, headers).storeKey,
    );
    expect(resolveGeminiSessionScope(unknown, headers).storeKey).not.toBe(
      resolveGeminiSessionScope(gemini, headers).storeKey,
    );
  });

  it('keeps ambiguous M4V audio/video compatibility outside shared media identity', () => {
    const openAI: OpenAIChatRequest = {
      model: 'gemini-3-flash',
      messages: [
        {
          role: 'user',
          content: [{ type: 'video_url', video_url: { url: video, mime_type: 'm4v' } }],
        },
      ],
    };
    const unchanged: OpenAIChatRequest = {
      ...openAI,
      messages: [
        {
          role: 'user',
          content: [{ type: 'video_url', video_url: { url: video } }],
        },
      ],
    };

    expect(resolveOpenAISessionScope(openAI, headers).storeKey).not.toBe(
      resolveOpenAISessionScope(unchanged, headers).storeKey,
    );
  });
});
