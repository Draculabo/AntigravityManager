import { describe, expect, it } from 'vitest';
import {
  buildResponsesChatRequest,
  normalizeResponsesMessageContent,
  parseResponsesRequestBody,
} from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-request';
import { mergeOpenAIResponsesInputItems } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-session.store';

describe('Responses input compatibility', () => {
  it('validates a WebSocket Responses request before mapping it', () => {
    expect(
      parseResponsesRequestBody({
        model: 'gpt-5-codex',
        input: 'Continue the task.',
        metadata: { trace: 'ws-1' },
        session_id: 'routing-1',
        tools: [
          {
            type: 'function',
            function: {
              name: 'apply_patch',
              parameters: { type: 'object' },
            },
          },
        ],
        tool_choice: { type: 'function', function: { name: 'apply_patch' } },
        stream: true,
        text: { format: { type: 'text' } },
      }),
    ).toMatchObject({
      model: 'gpt-5-codex',
      input: 'Continue the task.',
      metadata: { trace: 'ws-1' },
      session_id: 'routing-1',
      tools: [
        {
          type: 'function',
          function: {
            name: 'apply_patch',
            parameters: { type: 'object' },
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'apply_patch' } },
      stream: true,
      text: { format: { type: 'text' } },
    });
  });

  it.each([
    { model: 7 },
    { metadata: ['not', 'an', 'object'] },
    { session_id: 7 },
    { tools: [{ type: 'function', function: { name: 7 } }] },
    { tool_choice: { type: 'function', function: { name: 7 } } },
  ])('rejects a malformed WebSocket request field: %j', (body) => {
    expect(parseResponsesRequestBody(body)).toBeNull();
  });

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
    'handles object content %j without removing the enclosing message',
    (content) => {
      const input = [
        { role: 'user', content },
        { type: 'message', role: 'assistant', content },
        { type: 'message', role: 'user', content: 'Continue.' },
      ];
      const before = structuredClone(input);

      expect(buildResponsesChatRequest({ input }).messages).toEqual([
        { role: 'user', content: 'text' in content ? content.text : '' },
        { role: 'assistant', content: 'text' in content ? content.text : '' },
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

  it('preserves text and images from Responses tool output', () => {
    expect(
      buildResponsesChatRequest({
        input: [
          { role: 'user', content: 'Generate an image.' },
          { type: 'function_call', call_id: 'call_image', name: 'view_image', arguments: '{}' },
          {
            type: 'function_call_output',
            call_id: 'call_image',
            output: {
              content: [
                { type: 'input_text', text: 'image generated' },
                { type: 'input_image', image_url: 'data:image/png;base64,AQ==' },
              ],
            },
          },
        ],
      }).messages.at(-1),
    ).toEqual({
      role: 'tool',
      tool_call_id: 'call_image',
      name: 'view_image',
      content: [
        { type: 'text', text: 'image generated' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==' } },
      ],
    });
  });

  it('keeps pure tool images without fabricating text and retains unknown JSON fallback', () => {
    const request = buildResponsesChatRequest({
      input: [
        { role: 'user', content: 'Inspect.' },
        { type: 'function_call', call_id: 'call_image', name: 'view_image', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'call_image',
          output: { type: 'input_image', image_url: 'data:image/png;base64,AQ==' },
        },
        { type: 'function_call', call_id: 'call_unknown', name: 'read_value', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'call_unknown',
          output: [{ value: 41 }],
        },
      ],
    });

    expect(request.messages[2]?.content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==' } },
    ]);
    expect(request.messages.at(-1)?.content).toBe('[{"value":41}]');
  });

  it('compacts repeated apply_patch failures without dropping tool media', () => {
    const input: unknown[] = [{ role: 'user', content: 'Apply the patch.' }];
    for (let index = 1; index <= 7; index += 1) {
      input.push(
        {
          type: 'function_call',
          call_id: `call_patch_${index}`,
          name: 'apply_patch',
          arguments: '{}',
        },
        {
          type: 'function_call_output',
          call_id: `call_patch_${index}`,
          output: [
            {
              type: 'input_text',
              text: `apply_patch verification failed\nDistinct failure ${index}`,
            },
            { type: 'input_image', image_url: 'data:image/png;base64,AQ==' },
          ],
        },
      );
    }

    expect(buildResponsesChatRequest({ input }).messages.at(-1)?.content).toEqual([
      {
        type: 'text',
        text: '[Additional apply_patch failure omitted to avoid a retry loop. Produce a fresh V4A patch from current file contents instead of repeating previous failed patches.]',
      },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==' } },
    ]);
  });
});
