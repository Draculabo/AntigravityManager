import { describe, expect, it } from 'vitest';
import {
  buildResponsesChatRequest,
  normalizeResponsesMessageContent,
} from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-request';
import { mergeOpenAIResponsesInputItems } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-session.store';

describe('Responses input compatibility', () => {
  it.each([undefined, null, 4, false])(
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

  it('omits only a strictly empty merged text block when images are present', () => {
    const imagePart = {
      type: 'image_url' as const,
      image_url: { url: 'https://example.com/image.png' },
    };

    expect(normalizeResponsesMessageContent([{ text: '' }, imagePart])).toEqual([imagePart]);
    expect(normalizeResponsesMessageContent([{ text: ' ' }, imagePart])).toEqual([
      { type: 'text', text: ' ' },
      imagePart,
    ]);
    expect(normalizeResponsesMessageContent([{ text: '' }, { text: '' }, imagePart])).toEqual([
      { type: 'text', text: '\n' },
      imagePart,
    ]);
  });

  it('ignores empty and unknown explicit types while retaining the default message role', () => {
    expect(
      buildResponsesChatRequest({
        input: [
          { type: '', role: 'user', content: 'Not a message either.' },
          { type: 'unrecognized', role: 'user', content: 'Not a message.' },
          { type: 'message', role: null, content: 'Default role.' },
        ],
      }).messages,
    ).toEqual([{ role: 'user', content: 'Default role.' }]);
  });

  it.each(['user', 'assistant', 'system'])(
    'ignores empty-type %s history without mutating the raw items',
    (role) => {
      const history = [{ type: '', role, content: 'Ignored legacy text.' }];
      const before = structuredClone(history);
      const input = mergeOpenAIResponsesInputItems(history, [
        { role: 'user', content: 'Continue.' },
      ]);

      expect(buildResponsesChatRequest({ input }).messages).toEqual([
        { role: 'user', content: 'Continue.' },
      ]);
      expect(history).toEqual(before);
    },
  );

  it.each([{}, { legacy: true }, { text: 'Not an array block.' }, { nested: { value: 1 } }])(
    'ignores object content %j without removing the enclosing message',
    (content) => {
      const input = [
        { role: 'user', content },
        { type: 'message', role: 'assistant', content },
        { type: 'message', role: 'user', content: 'Continue.' },
      ];
      const before = structuredClone(input);

      expect(buildResponsesChatRequest({ input }).messages).toEqual([
        { role: 'user', content: '' },
        { role: 'assistant', content: '' },
        { role: 'user', content: 'Continue.' },
      ]);
      expect(input).toEqual(before);
    },
  );

  it('retains the empty-user fallback when every input item is ignored', () => {
    expect(
      buildResponsesChatRequest({
        input: [{ type: '', role: 'assistant', content: 'Ignored prefill.' }],
      }).messages,
    ).toEqual([{ role: 'user', content: '' }]);
  });

  it('does not change object serialization for top-level input or tool output', () => {
    expect(buildResponsesChatRequest({ input: { legacy: true } }).messages).toEqual([
      { role: 'user', content: '{"legacy":true}' },
    ]);
    expect(
      buildResponsesChatRequest({
        input: [
          { role: 'user', content: 'Read the value.' },
          { type: 'function_call', call_id: 'call_1', name: 'read_value', arguments: '{}' },
          { type: 'function_call_output', call_id: 'call_1', output: { value: 41 } },
        ],
      }).messages,
    ).toEqual([
      { role: 'user', content: 'Read the value.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'read_value', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', name: 'read_value', content: '{"value":41}' },
    ]);
  });

  it('retains image objects nested in array content', () => {
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
