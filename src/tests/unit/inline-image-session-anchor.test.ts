import { describe, expect, it } from 'vitest';
import {
  resolveAnthropicSessionScope,
  resolveGeminiSessionScope,
  resolveOpenAISessionScope,
  resolveResponsesSessionScope,
} from '@/server/gateway/common/signature-session-scope';
import { buildResponsesChatRequest } from '@/server/gateway/modules/openai/responses/openai-responses-request';
import type {
  OpenAIChatRequest,
  AnthropicChatRequest,
  GeminiRequest,
} from '@/server/gateway/common/interfaces/request-interfaces';

const headers = { authorization: 'Bearer synthetic-tenant', 'x-session-id': 'synthetic-session' };
const data =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2Z8AAAAASUVORK5CYII=';
function inputs(encoded = data, mime = 'image/png') {
  const url = `data:${mime};base64,${encoded}`;
  const chat: OpenAIChatRequest = {
    model: 'gemini-3-flash',
    messages: [
      { role: 'system', content: 'Read only.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe the image.' },
          { type: 'image_url', image_url: { url } },
        ],
      },
    ],
  };
  const messages: AnthropicChatRequest = {
    model: chat.model,
    system: 'Read only.',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe the image.' },
          { type: 'image', source: { type: 'base64', media_type: mime, data: encoded } },
        ],
      },
    ],
  };
  const gemini: GeminiRequest = {
    systemInstruction: { parts: [{ text: 'Read only.' }] },
    contents: [
      {
        role: 'user',
        parts: [{ text: 'Describe the image.' }, { inlineData: { mimeType: mime, data: encoded } }],
      },
    ],
  };
  const responses = buildResponsesChatRequest({
    model: chat.model,
    instructions: 'Read only.',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Describe the image.' },
          { type: 'input_image', image_url: url },
        ],
      },
    ],
  });
  return { chat, messages, gemini, responses };
}
function scopes(value = inputs()) {
  return [
    resolveOpenAISessionScope(value.chat, headers),
    resolveAnthropicSessionScope(value.messages, headers),
    resolveGeminiSessionScope(value.gemini, headers),
    resolveResponsesSessionScope(value.responses, 'synthetic-session', headers),
  ];
}
describe('inline image logical session anchors', () => {
  it('unifies equivalent inline-image tasks across all four protocols without merging signature scopes', () => {
    const result = scopes();
    expect(new Set(result.map((x) => x.storeKey)).size).toBe(1);
    expect(new Set(result.map((x) => x.affinityKey)).size).toBe(1);
    expect(new Set(result.map((x) => x.cacheKey)).size).toBe(3);
  });
  it('retains image payload, MIME, order, text boundaries and initial instructions', () => {
    const base = scopes();
    for (const request of [
      inputs(Buffer.from('different image bytes').toString('base64')),
      inputs(data, 'image/jpeg'),
    ]) {
      const changed = scopes(request);
      expect(new Set(changed.map((x) => x.storeKey)).size).toBe(1);
      expect(changed[0].storeKey).not.toBe(base[0].storeKey);
      expect(changed.map((x) => x.affinityKey)).toEqual(base.map((x) => x.affinityKey));
    }
    const value = inputs();
    const content = value.chat.messages[1].content;
    if (!Array.isArray(content)) throw new Error('Expected mixed fixture');
    expect(
      resolveOpenAISessionScope(
        {
          ...value.chat,
          messages: [value.chat.messages[0], { role: 'user', content: [...content].reverse() }],
        },
        headers,
      ).storeKey,
    ).not.toBe(base[0].storeKey);
    expect(
      resolveOpenAISessionScope(
        {
          ...value.chat,
          messages: [{ role: 'system', content: 'Write files.' }, value.chat.messages[1]],
        },
        headers,
      ).storeKey,
    ).not.toBe(base[0].storeKey);
  });
  it('preserves the anchor on appended turns and excludes tool-only preambles', () => {
    const value = inputs(),
      base = scopes(value);
    expect(
      resolveAnthropicSessionScope(
        {
          ...value.messages,
          messages: [
            {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'old', content: 'old' }],
            },
            ...value.messages.messages,
            { role: 'assistant', content: 'ok' },
            { role: 'user', content: 'Continue' },
          ],
        },
        headers,
      ),
    ).toEqual(base[1]);
    expect(
      resolveGeminiSessionScope(
        {
          ...value.gemini,
          contents: [
            ...value.gemini.contents,
            { role: 'model', parts: [{ text: 'ok' }] },
            { role: 'user', parts: [{ text: 'Continue' }] },
          ],
        },
        headers,
      ),
    ).toEqual(base[2]);
  });
  it('keeps explicit image processing options and reference images conservative', () => {
    const value = inputs(),
      base = scopes(value)[0];
    for (const image_url of [
      { url: `data:image/png;base64,${data}`, detail: 'high' as const },
      'https://example.invalid/image.png',
    ]) {
      expect(
        resolveOpenAISessionScope(
          {
            ...value.chat,
            messages: [
              value.chat.messages[0],
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'Describe the image.' },
                  { type: 'image_url', image_url },
                ],
              },
            ],
          },
          headers,
        ).storeKey,
      ).not.toBe(base.storeKey);
    }
  });
  it('retains tenant isolation and the existing pure-text identity', () => {
    const value = inputs();
    const result = scopes(value);
    expect(
      resolveGeminiSessionScope(value.gemini, { ...headers, authorization: 'Bearer other' })
        .storeKey,
    ).not.toBe(result[2].storeKey);
    const text: OpenAIChatRequest = {
      model: 'gemini-3-flash',
      messages: [
        { role: 'system', content: 'Read only.' },
        { role: 'user', content: 'Describe the image.' },
      ],
    };
    expect(resolveOpenAISessionScope(text, headers).storeKey).not.toBe(result[0].storeKey);
    expect(resolveOpenAISessionScope(text, headers).storeKey).toEqual(
      resolveAnthropicSessionScope(
        {
          model: text.model,
          system: 'Read only.',
          messages: [{ role: 'user', content: 'Describe the image.' }],
        },
        headers,
      ).storeKey,
    );
  });
  it('fingerprints complete large encoded content and retains unknown media fields', () => {
    const encoded = 'A'.repeat(2 * 1024 * 1024);
    const base = scopes(inputs(encoded));
    expect(new Set(base.map((x) => x.storeKey)).size).toBe(1);
    const changed = scopes(inputs(encoded.slice(0, 500000) + 'B' + encoded.slice(500001)));
    expect(new Set(changed.map((x) => x.storeKey)).size).toBe(1);
    expect(changed[0].storeKey).not.toBe(base[0].storeKey);
    const value = inputs();
    const part = value.gemini.contents[0].parts[1];
    expect(
      resolveGeminiSessionScope(
        {
          ...value.gemini,
          contents: [
            {
              role: 'user',
              parts: [
                value.gemini.contents[0].parts[0],
                Object.assign({}, part, { thought: true }),
              ],
            },
          ],
        },
        headers,
      ).storeKey,
    ).not.toBe(scopes(value)[2].storeKey);
    const image = {
      type: 'image' as const,
      source: Object.assign(
        { type: 'base64' as const, media_type: 'image/png', data },
        { processing: 'crop' },
      ),
    };
    expect(
      resolveAnthropicSessionScope(
        {
          ...value.messages,
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'Describe the image.' }, image] },
          ],
        },
        headers,
      ).storeKey,
    ).not.toBe(scopes(value)[1].storeKey);
  });
});
