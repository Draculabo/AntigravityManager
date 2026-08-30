import { describe, expect, it } from 'vitest';
import {
  buildResponsesChatRequest,
  normalizeResponsesMessageContent,
} from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-request';
import { mergeOpenAIResponsesInputItems } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-session.store';

describe('Responses input compatibility', () => {
  it.each([undefined, null, 4, ''])(
    'filters commentary with type %s without rewriting stored items',
    (type) => {
      const history = [
        { type, role: 'assistant', phase: 'commentary', content: 'Display only.' },
        { type, role: 'assistant', content: 'The answer is 41.' },
      ];
      const before = structuredClone(history);
      const input = mergeOpenAIResponsesInputItems(history, [
        { role: 'user', content: 'Continue.' },
      ]);
      expect(buildResponsesChatRequest({ input }).messages).toEqual([
        { role: 'assistant', content: 'The answer is 41.' },
        { role: 'user', content: 'Continue.' },
      ]);
      expect(history).toEqual(before);
    },
  );

  it('does not concatenate text blocks into a false thinking prefix', () => {
    const message = {
      type: 'message',
      role: 'assistant',
      content: [{ text: '**Think' }, { text: 'ing** is ordinary text.' }],
    };
    expect(mergeOpenAIResponsesInputItems([message], [])).toEqual([message]);
    expect(
      mergeOpenAIResponsesInputItems(
        [{ ...message, content: [{ text: '' }, { text: '**Thinking**\nDisplay only.' }] }],
        [],
      ),
    ).toEqual([]);
  });

  it('preserves untyped text, empty text separators, and text priority over images', () => {
    expect(
      normalizeResponsesMessageContent([
        { text: 'a' },
        { type: 'other', text: '' },
        { text: 'b' },
        { type: 'input_image', image_url: 'https://example.com/ignored.png', text: '' },
      ]),
    ).toBe('a\n\nb\n');
  });

  it('preserves image detail and validated JSON extensions', () => {
    const image = {
      url: 'https://example.com/image.png',
      detail: 'high',
      extension: { reference: 2 },
    };
    expect(normalizeResponsesMessageContent([{ type: 'image_url', image_url: image }])).toEqual([
      { type: 'image_url', image_url: image },
    ]);
  });

  it('keeps accepted legacy input forms while ignoring unknown explicit types', () => {
    expect(
      buildResponsesChatRequest({
        input: [
          { type: '', role: 'user', content: { legacy: true } },
          { type: 'unrecognized', role: 'user', content: 'Not a message.' },
          { type: 'message', role: null, content: 'Default role.' },
        ],
      }).messages,
    ).toEqual([
      { role: 'user', content: '{"legacy":true}' },
      { role: 'user', content: 'Default role.' },
    ]);
    expect(
      normalizeResponsesMessageContent([
        { type: 'input_image', image_url: { url: 'https://example.com/legacy.png' } },
      ]),
    ).toEqual([{ type: 'image_url', image_url: { url: 'https://example.com/legacy.png' } }]);
  });

  it('rejects malformed image objects instead of forwarding unchecked fields', () => {
    expect(
      normalizeResponsesMessageContent([
        { type: 'image_url', image_url: null },
        { type: 'image_url', image_url: { url: 7 } },
        { type: 'image_url', image_url: { url: 'https://example.com/image.png', detail: 7 } },
      ]),
    ).toBe('');
  });
});
