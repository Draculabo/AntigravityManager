import { afterEach, describe, expect, it } from 'vitest';

import { OpenAIResponsesStreamingMapper } from '@/modules/proxy-gateway/antigravity/OpenAIResponsesStreamingMapper';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';

function parseEvent(serializedEvent: string): Record<string, unknown> {
  const dataLine = serializedEvent.split('\n').find((line) => line.startsWith('data: '));
  if (!dataLine) {
    throw new Error(`Missing SSE data line: ${serializedEvent}`);
  }
  return JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
}

function parseEventName(serializedEvent: string): string {
  const eventLine = serializedEvent.split('\n').find((line) => line.startsWith('event: '));
  if (!eventLine) {
    throw new Error(`Missing SSE event line: ${serializedEvent}`);
  }
  return eventLine.slice('event: '.length);
}

function createMapper(): OpenAIResponsesStreamingMapper {
  return new OpenAIResponsesStreamingMapper({
    model: 'gemini-3-pro',
    responseId: 'resp_test',
  });
}

describe('OpenAIResponsesStreamingMapper', () => {
  afterEach(() => {
    SignatureStore.clear();
  });

  it('emits a complete Responses tool-call lifecycle without creating an empty text item', () => {
    const mapper = createMapper();
    const events = [
      mapper.createResponseCreatedEvent(),
      mapper.createResponseInProgressEvent(),
      ...mapper.processPart({
        functionCall: {
          args: { cmd: 'dir' },
          id: 'call_shell_1',
          name: 'shell',
        },
      }),
      ...mapper.complete(),
    ].map(parseEvent);

    expect(events.map((event) => event.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.custom_tool_call_input.delta',
      'response.custom_tool_call_input.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(events[2]).toMatchObject({
      item: {
        call_id: 'call_shell_1',
        name: 'shell',
        type: 'custom_tool_call',
      },
      output_index: 0,
    });
    expect(events[3]).toMatchObject({ delta: '{"command":"dir"}' });
    expect(events[6]).toMatchObject({
      response: {
        output: [
          {
            input: '{"command":"dir"}',
            call_id: 'call_shell_1',
            type: 'custom_tool_call',
          },
        ],
      },
    });
  });

  it('uses the shell tool name declared by the client', () => {
    const mapper = new OpenAIResponsesStreamingMapper({
      clientToolNames: new Set(['bash']),
      model: 'gemini-3-pro',
      responseId: 'resp_shell_name',
    });
    const events = mapper
      .processPart({
        functionCall: {
          args: { command: 'pwd' },
          id: 'call_shell_name',
          name: 'shell',
        },
      })
      .map(parseEvent);

    expect(events.at(-1)).toMatchObject({
      item: {
        name: 'bash',
        type: 'function_call',
      },
      type: 'response.output_item.done',
    });
  });

  it('emits apply_patch as a custom tool call with raw patch input', () => {
    const mapper = createMapper();
    const patch = '*** Begin Patch\n*** Update File: src/example.ts\n*** End Patch';
    const events = [
      ...mapper.processPart({
        functionCall: {
          args: { command: ['apply_patch', patch] },
          id: 'call_patch_1',
          name: 'apply_patch',
        },
      }),
      ...mapper.complete(),
    ].map(parseEvent);

    expect(events.map((event) => event.type)).toEqual([
      'response.output_item.added',
      'response.custom_tool_call_input.delta',
      'response.custom_tool_call_input.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(events[0]).toMatchObject({
      item: {
        call_id: 'call_patch_1',
        id: 'item_resp_test_0',
        input: '',
        name: 'apply_patch',
        type: 'custom_tool_call',
      },
    });
    expect(events[1]).toMatchObject({
      call_id: 'call_patch_1',
      delta: patch,
      item_id: 'item_resp_test_0',
    });
    expect(events[4]).toMatchObject({
      response: {
        output: [
          {
            call_id: 'call_patch_1',
            id: 'item_resp_test_0',
            input: patch,
            name: 'apply_patch',
            type: 'custom_tool_call',
          },
        ],
      },
    });
  });

  it('repairs apply_patch input before emitting the custom tool call', () => {
    const mapper = createMapper();
    const patch = [
      '*** Begin Patch',
      '--- a/src/example.ts',
      '+++ b/src/example.ts',
      '@@ -1 +1 @@',
      '-const value = 1;',
      '+const value = 2;',
      '*** End Patch',
    ].join('\n');
    const repairedPatch = [
      '*** Begin Patch',
      '*** Update File: src/example.ts',
      '@@',
      '-const value = 1;',
      '+const value = 2;',
      '*** End Patch',
    ].join('\n');

    const events = mapper
      .processPart({
        functionCall: {
          args: { input: patch },
          id: 'call_patch_repair',
          name: 'apply_patch',
        },
      })
      .map(parseEvent);

    expect(events[1]).toMatchObject({
      delta: repairedPatch,
      type: 'response.custom_tool_call_input.delta',
    });
    expect(events[2]).toMatchObject({
      input: repairedPatch,
      type: 'response.custom_tool_call_input.done',
    });
    expect(events[3]).toMatchObject({
      item: {
        input: repairedPatch,
        name: 'apply_patch',
      },
      type: 'response.output_item.done',
    });
  });

  it('emits a text diagnostic instead of an invalid apply_patch tool call', () => {
    const mapper = createMapper();
    const events = mapper
      .processPart({
        functionCall: {
          args: { input: 'this is not a patch' },
          id: 'call_patch_invalid',
          name: 'apply_patch',
        },
      })
      .map(parseEvent);

    expect(events.map((event) => event.type)).toEqual([
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
    ]);
    expect(events[0]).toMatchObject({
      item: {
        type: 'message',
      },
    });
    expect(events[2]).toMatchObject({
      delta: expect.stringContaining('apply_patch rejected'),
    });
  });

  it('allocates sequential output indexes across text and tool calls', () => {
    const mapper = createMapper();
    const events = [
      ...mapper.processPart({ text: 'Hello' }),
      ...mapper.processPart({
        functionCall: {
          args: { query: 'Gemini API' },
          id: 'call_search_1',
          name: 'search_docs',
        },
      }),
      ...mapper.complete(),
    ].map(parseEvent);

    const addedItems = events.filter((event) => event.type === 'response.output_item.added');
    expect(addedItems[0]).toMatchObject({
      output_index: 0,
      type: 'response.output_item.added',
    });
    expect(addedItems[1]).toMatchObject({
      output_index: 1,
      type: 'response.output_item.added',
    });
    expect(events.at(-1)).toMatchObject({
      response: {
        output: [
          expect.objectContaining({ type: 'message' }),
          expect.objectContaining({ type: 'function_call' }),
        ],
      },
      type: 'response.completed',
    });
  });

  it('emits reasoning as a separate commentary message before the final answer', () => {
    const mapper = createMapper();
    const events = [
      ...mapper.processPart({ text: '<think>inspect\nfiles</think>', thought: true }),
      ...mapper.processPart({ text: 'Done.' }),
      ...mapper.complete(),
    ].map(parseEvent);

    expect(events.at(-1)).toMatchObject({
      response: {
        output: [
          {
            content: [{ text: 'inspect\nfiles', type: 'output_text' }],
            id: expect.stringMatching(/^msg_thought_/),
            phase: 'commentary',
            type: 'message',
          },
          {
            content: [{ text: 'Done.', type: 'output_text' }],
            phase: 'final_answer',
            type: 'message',
          },
        ],
      },
    });
  });

  it('closes reasoning before a tool call and keeps their output indexes distinct', () => {
    const mapper = createMapper();
    const events = [
      ...mapper.processPart({ text: 'Inspecting', thought: true }),
      ...mapper.processPart({
        functionCall: {
          args: { query: 'Responses API' },
          id: 'call_reasoning_tool',
          name: 'search_docs',
        },
      }),
      ...mapper.complete(),
    ].map(parseEvent);

    const thoughtDoneIndex = events.findIndex(
      (event) =>
        event.type === 'response.output_item.done' &&
        typeof event.item === 'object' &&
        event.item !== null &&
        Reflect.get(event.item, 'phase') === 'commentary',
    );
    const toolAddedIndex = events.findIndex(
      (event) =>
        event.type === 'response.output_item.added' &&
        typeof event.item === 'object' &&
        event.item !== null &&
        Reflect.get(event.item, 'type') === 'function_call',
    );

    expect(thoughtDoneIndex).toBeGreaterThanOrEqual(0);
    expect(toolAddedIndex).toBeGreaterThan(thoughtDoneIndex);
    expect(events[thoughtDoneIndex]).toMatchObject({ output_index: 0 });
    expect(events[toolAddedIndex]).toMatchObject({ output_index: 1 });
  });

  it('drops thought chunks that arrive after final-answer text has started', () => {
    const mapper = createMapper();
    mapper.processPart({ text: 'Final answer' });

    expect(mapper.processPart({ text: 'late thought', thought: true })).toEqual([]);

    const completed = mapper.complete().map(parseEvent).at(-1);
    expect(completed).toMatchObject({
      response: {
        output: [
          {
            content: [{ text: 'Final answer', type: 'output_text' }],
            phase: 'final_answer',
          },
        ],
      },
    });
  });

  it('aligns SSE event names with event types and emits monotonic sequence numbers', () => {
    const mapper = createMapper();
    const serializedEvents = [
      mapper.createResponseCreatedEvent(),
      mapper.createResponseInProgressEvent(),
      ...mapper.processPart({ text: 'Done.' }),
      ...mapper.complete(),
    ];
    const events = serializedEvents.map(parseEvent);

    expect(serializedEvents.map(parseEventName)).toEqual(events.map((event) => event.type));
    expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index));
    expect(events.at(-1)?.type).toBe('response.completed');
  });

  it('does not collapse identical calls that have no upstream call ID', () => {
    const mapper = createMapper();
    const events = [
      ...mapper.processPart({
        functionCall: {
          args: { query: 'same query' },
          name: 'search_docs',
        },
      }),
      ...mapper.processPart({
        functionCall: {
          args: { query: 'same query' },
          name: 'search_docs',
        },
      }),
    ].map(parseEvent);

    const addedItems = events.filter((event) => event.type === 'response.output_item.added');
    expect(addedItems).toHaveLength(2);
    expect(addedItems[0]).toMatchObject({ item: { call_id: 'call_resp_test_0' } });
    expect(addedItems[1]).toMatchObject({ item: { call_id: 'call_resp_test_1' } });
  });

  it('preserves a function call marked as thought and stores its thought signature', () => {
    const mapper = createMapper();
    const encodedSignature = Buffer.from('stored thought signature').toString('base64');
    const events = mapper.processPart({
      functionCall: {
        args: { command: 'pwd' },
        id: 'call_thought_1',
        name: 'shell',
      },
      thought: true,
      thoughtSignature: encodedSignature,
    });

    expect(events.map((event) => parseEvent(event).type)).toEqual([
      'response.output_item.added',
      'response.custom_tool_call_input.delta',
      'response.custom_tool_call_input.done',
      'response.output_item.done',
    ]);
    expect(SignatureStore.get()).toBe('stored thought signature');
  });

  it('stores thought signatures under the supplied session key', () => {
    const mapper = new OpenAIResponsesStreamingMapper({
      model: 'gemini-3-pro',
      responseId: 'resp_session_test',
      signatureMessageCount: 4,
      signatureSessionKey: 'openai:session-a',
    });
    const encodedSignature = Buffer.from('session a thought signature').toString('base64');

    mapper.processPart({ thought: true, thoughtSignature: encodedSignature });

    expect(SignatureStore.get('openai:session-a')).toBe('session a thought signature');
    expect(SignatureStore.getAt('openai:session-a', 4)).toBe('session a thought signature');
    expect(SignatureStore.get()).toBeNull();
  });

  it('emits grounding metadata as visible Responses text', () => {
    const mapper = createMapper();
    const events = [
      ...mapper.processGrounding({
        groundingChunks: [
          {
            web: {
              title: 'Gemini API documentation',
              uri: 'https://example.com/gemini',
            },
          },
        ],
        webSearchQueries: ['Gemini API'],
      }),
      ...mapper.complete(),
    ].map(parseEvent);

    expect(events.map((event) => event.type)).toEqual([
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(events[2]).toMatchObject({
      delta: expect.stringContaining('**🌐 Citations:**'),
    });
  });

  it('includes normalized usage in the completed response event', () => {
    const mapper = createMapper();
    mapper.setUsage({
      input_tokens: 12,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens: 8,
      output_tokens_details: { reasoning_tokens: 3 },
      total_tokens: 20,
    });

    const completed = parseEvent(mapper.complete().at(-1) ?? '');

    expect(completed).toMatchObject({
      response: {
        usage: {
          input_tokens: 12,
          input_tokens_details: { cached_tokens: 4 },
          output_tokens: 8,
          output_tokens_details: { reasoning_tokens: 3 },
          total_tokens: 20,
        },
      },
      type: 'response.completed',
    });
  });
  it('reports a truncated answer as incomplete instead of completed', () => {
    const mapper = createMapper();
    const events = [
      ...mapper.processPart({ text: 'the answer starts and then run' }),
      ...mapper.complete('MAX_TOKENS'),
    ].map(parseEvent);
    const closing = events.at(-1) ?? {};
    const itemDone = events.find((event) => event.type === 'response.output_item.done') ?? {};

    expect(closing).toMatchObject({
      response: {
        incomplete_details: { reason: 'max_output_tokens' },
        status: 'incomplete',
      },
      type: 'response.incomplete',
    });
    expect(itemDone).toMatchObject({ item: { status: 'incomplete', type: 'message' } });
  });

  it('leaves a safety stop with the refusal shape this gateway already gives it', () => {
    const mapper = createMapper();
    const closing = parseEvent(
      [...mapper.processPart({ text: 'partial' }), ...mapper.complete('SAFETY')].at(-1) ?? '',
    );

    expect(closing).toMatchObject({
      response: { incomplete_details: null, status: 'completed' },
      type: 'response.completed',
    });
  });

  it('keeps a naturally finished answer completed with no incomplete details', () => {
    const mapper = createMapper();
    const events = [
      ...mapper.processPart({ text: 'the whole answer' }),
      ...mapper.complete('STOP'),
    ].map(parseEvent);
    const closing = events.at(-1) ?? {};
    const itemDone = events.find((event) => event.type === 'response.output_item.done') ?? {};

    expect(closing).toMatchObject({
      response: { incomplete_details: null, status: 'completed' },
      type: 'response.completed',
    });
    expect(itemDone).toMatchObject({ item: { status: 'completed', type: 'message' } });
  });
});
