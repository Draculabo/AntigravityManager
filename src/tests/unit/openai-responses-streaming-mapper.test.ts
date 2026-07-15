import { afterEach, describe, expect, it } from 'vitest';

import { OpenAIResponsesStreamingMapper } from '@/modules/proxy-gateway/antigravity/OpenAIResponsesStreamingMapper';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';

function parseEvent(serializedEvent: string): Record<string, unknown> {
  return JSON.parse(serializedEvent.slice('data: '.length)) as Record<string, unknown>;
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
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(events[1]).toMatchObject({
      item: {
        call_id: 'call_shell_1',
        name: 'shell',
        type: 'function_call',
      },
      output_index: 0,
    });
    expect(events[2]).toMatchObject({ delta: '{"command":"dir"}' });
    expect(events[5]).toMatchObject({
      response: {
        output: [
          {
            arguments: '{"command":"dir"}',
            call_id: 'call_shell_1',
            type: 'function_call',
          },
        ],
      },
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

    expect(events[0]).toMatchObject({ output_index: 0, type: 'response.output_item.added' });
    expect(events[3]).toMatchObject({ output_index: 1, type: 'response.output_item.added' });
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
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
    ]);
    expect(SignatureStore.get()).toBe('stored thought signature');
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
});
