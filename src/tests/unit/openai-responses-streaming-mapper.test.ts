import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { OpenAIResponsesStreamingMapper } from '@/server/gateway/modules/openai/responses/OpenAIResponsesStreamingMapper';
import type { OpenAITool } from '@/server/gateway/common/interfaces/request-interfaces';
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

function createMapper(clientTools?: OpenAITool[]): OpenAIResponsesStreamingMapper {
  return new OpenAIResponsesStreamingMapper({
    clientTools,
    model: 'gemini-3-pro',
    responseId: 'resp_test',
    signatureSourceModel: 'gemini-3-pro',
    signatureSessionKey: 'openai:resp_test',
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
        toolCall: {
          arguments: { cmd: 'dir' },
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
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(events[2]).toMatchObject({
      item: {
        call_id: 'call_shell_1',
        name: 'shell',
        type: 'function_call',
      },
      output_index: 0,
    });
    expect(events[3]).toMatchObject({ delta: '{"cmd":"dir"}' });
    expect(events[6]).toMatchObject({
      response: {
        output: [
          {
            arguments: '{"cmd":"dir"}',
            call_id: 'call_shell_1',
            type: 'function_call',
          },
        ],
      },
    });
  });

  it('preserves the upstream shell tool name', () => {
    const mapper = new OpenAIResponsesStreamingMapper({
      model: 'gemini-3-pro',
      responseId: 'resp_shell_name',
    });
    const events = [
      ...mapper.processPart({
        toolCall: {
          arguments: { command: 'pwd' },
          id: 'call_shell_name',
          name: 'shell',
        },
      }),
    ].map(parseEvent);

    expect(events.at(-1)).toMatchObject({
      item: {
        name: 'shell',
        type: 'function_call',
      },
      type: 'response.output_item.done',
    });
  });

  it('preserves PowerShell spelling, blank commands and parameter aliases', () => {
    const mapper = new OpenAIResponsesStreamingMapper({
      model: 'gemini-3-pro',
      responseId: 'resp_powershell',
    });
    const events = [
      ...mapper.processPart({
        toolCall: {
          arguments: { command: '   ', input: 'Get-Location' },
          id: 'call_powershell',
          name: 'powershell',
        },
      }),
    ].map(parseEvent);
    const completedTool = events.at(-1);

    expect(completedTool).toMatchObject({
      item: { name: 'powershell', type: 'function_call' },
      type: 'response.output_item.done',
    });
    expect(
      JSON.parse(
        String(Reflect.get(Reflect.get(completedTool ?? {}, 'item') as object, 'arguments')),
      ),
    ).toEqual({
      command: '   ',
      input: 'Get-Location',
    });
  });

  it('emits one recovery message and a completed terminal event for a malformed function call', () => {
    const mapper = createMapper();
    const events = [...mapper.complete('MALFORMED_FUNCTION_CALL')].map(parseEvent);
    const deltas = events.filter((event) => event.type === 'response.output_text.delta');

    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({
      delta: expect.stringMatching(/tool call could not be generated/i),
    });
    expect(events.at(-1)).toMatchObject({
      response: {
        incomplete_details: null,
        output: [
          expect.objectContaining({
            content: [
              expect.objectContaining({
                text: expect.stringMatching(/tool call could not be generated/i),
              }),
            ],
            status: 'completed',
            type: 'message',
          }),
        ],
        status: 'completed',
      },
      type: 'response.completed',
    });
  });

  it('keeps declared custom input byte for byte across its complete streaming lifecycle', () => {
    const mapper = createMapper([{ type: 'custom', name: 'apply_patch' }]);
    const patch = '--- a/src/example.ts\r\n+++ b/src/example.ts\r\n@@ -1 +1 @@\r\n-x\r\n+y\r\n';
    const events = [
      ...mapper.processPart({
        toolCall: { arguments: { input: patch }, id: 'call_patch_1', name: 'apply_patch' },
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
    expect(events[1]).toMatchObject({ call_id: 'call_patch_1', delta: patch });
    expect(events[2]).toMatchObject({ call_id: 'call_patch_1', input: patch });
    const item = {
      call_id: 'call_patch_1',
      id: 'item_resp_test_0',
      input: patch,
      name: 'apply_patch',
      status: 'completed',
      type: 'custom_tool_call',
    };
    expect(events[3]?.item).toEqual(item);
    expect(events[4]).toMatchObject({ response: { output: [item] } });
  });

  it.each([undefined, [{ type: 'function', function: { name: 'apply_patch' } }]])(
    'keeps a same-name function call and its arguments without a custom declaration (%j)',
    (tools) => {
      const mapper = createMapper(tools);
      const args = {
        command: ['apply_patch', 'literal\r\npatch'],
        context: { path: 'src/example.ts' },
      };
      const events = [
        ...mapper.processPart({
          toolCall: { arguments: args, id: 'call_patch', name: 'apply_patch' },
        }),
      ].map(parseEvent);
      expect(events.map((event) => event.type)).toEqual([
        'response.output_item.added',
        'response.function_call_arguments.delta',
        'response.function_call_arguments.done',
        'response.output_item.done',
      ]);
      expect(events[3]?.item).toEqual({
        arguments: JSON.stringify(args),
        call_id: 'call_patch',
        id: 'item_resp_test_0',
        name: 'apply_patch',
        status: 'completed',
        type: 'function_call',
      });
    },
  );

  it('allocates sequential output indexes across text and tool calls', () => {
    const mapper = createMapper();
    const events = [
      ...mapper.processPart({ text: 'Hello' }),
      ...mapper.processPart({
        toolCall: {
          arguments: { query: 'Gemini API' },
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

  it('emits native reasoning summaries before the final answer', () => {
    const mapper = createMapper();
    const events = [
      ...mapper.processPart({ text: '<think>inspect\n', reasoning: true }),
      ...mapper.processPart({ text: 'files</think>', reasoning: true }),
      ...mapper.processPart({ text: 'Done.' }),
      ...mapper.complete(),
    ].map(parseEvent);

    expect(events.slice(0, 7).map((event) => event.type)).toEqual([
      'response.output_item.added',
      'response.reasoning_summary_part.added',
      'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.done',
      'response.reasoning_summary_part.done',
      'response.output_item.done',
    ]);
    const reasoningItemId = Reflect.get(events[0]?.item ?? {}, 'id');
    expect(reasoningItemId).toMatch(/^rs_[0-9a-f]{16}_0$/);
    expect(events[0]).toMatchObject({
      item: { status: 'in_progress', summary: [], type: 'reasoning' },
      output_index: 0,
    });
    expect(
      events.filter((event) => event.item_id === reasoningItemId).map((event) => event.type),
    ).toEqual([
      'response.reasoning_summary_part.added',
      'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.done',
      'response.reasoning_summary_part.done',
    ]);

    expect(events.at(-1)).toMatchObject({
      response: {
        output: [
          {
            id: expect.stringMatching(/^rs_[0-9a-f]{16}_0$/),
            status: 'completed',
            summary: [{ text: 'inspect\nfiles', type: 'summary_text' }],
            type: 'reasoning',
          },
          {
            content: [{ annotations: [], text: 'Done.', type: 'output_text' }],
            phase: 'final_answer',
            type: 'message',
          },
        ],
      },
    });
  });

  it('keeps output item ids independent from the public response id', () => {
    const mapper = createMapper();
    const events = [
      ...mapper.processPart({ text: 'Inspecting', reasoning: true }),
      ...mapper.processPart({ text: 'Done.' }),
      ...mapper.complete(),
    ].map(parseEvent);
    const completed = events.at(-1);
    const output = Reflect.get(Reflect.get(completed ?? {}, 'response') ?? {}, 'output') as Array<{
      id?: string;
    }>;

    expect(output).toHaveLength(2);
    expect(output[0]?.id).toMatch(/^rs_[0-9a-f]{16}_0$/);
    expect(output[1]?.id).toMatch(/^msg_[0-9a-f]{16}_1$/);
    expect(output.every((item) => !item.id?.includes('resp_test'))).toBe(true);
  });

  it('closes reasoning before a tool call and keeps their output indexes distinct', () => {
    const mapper = createMapper();
    const events = [
      ...mapper.processPart({ text: 'Inspecting', reasoning: true }),
      ...mapper.processPart({
        toolCall: {
          arguments: { query: 'Responses API' },
          id: 'call_reasoning_tool',
          name: 'search_docs',
        },
      }),
      ...mapper.complete(),
    ].map(parseEvent);

    const reasoningDoneIndex = events.findIndex(
      (event) =>
        event.type === 'response.output_item.done' &&
        typeof event.item === 'object' &&
        event.item !== null &&
        Reflect.get(event.item, 'type') === 'reasoning',
    );
    const toolAddedIndex = events.findIndex(
      (event) =>
        event.type === 'response.output_item.added' &&
        typeof event.item === 'object' &&
        event.item !== null &&
        Reflect.get(event.item, 'type') === 'function_call',
    );

    expect(reasoningDoneIndex).toBeGreaterThanOrEqual(0);
    expect(toolAddedIndex).toBeGreaterThan(reasoningDoneIndex);
    expect(events[reasoningDoneIndex]).toMatchObject({ output_index: 0 });
    expect(events[toolAddedIndex]).toMatchObject({ output_index: 1 });
  });

  it('closes a reasoning-only stream with a completed native output item', () => {
    const mapper = createMapper();
    const events = [
      ...mapper.processPart({ text: 'Inspecting', reasoning: true }),
      ...mapper.complete(),
    ].map(parseEvent);

    expect(events.map((event) => event.type)).toEqual([
      'response.output_item.added',
      'response.reasoning_summary_part.added',
      'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.done',
      'response.reasoning_summary_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(events[5]).toMatchObject({
      item: {
        status: 'completed',
        summary: [{ text: 'Inspecting', type: 'summary_text' }],
        type: 'reasoning',
      },
      output_index: 0,
    });
    expect(events[6]).toMatchObject({
      response: {
        output: [
          {
            status: 'completed',
            summary: [{ text: 'Inspecting', type: 'summary_text' }],
            type: 'reasoning',
          },
        ],
      },
      type: 'response.completed',
    });
  });

  it('marks native reasoning incomplete when the stream is truncated', () => {
    const mapper = createMapper();
    const events = [
      ...mapper.processPart({ text: 'Inspecting', reasoning: true }),
      ...mapper.complete('MAX_TOKENS'),
    ].map(parseEvent);

    expect(events.find((event) => event.type === 'response.output_item.done')).toMatchObject({
      item: {
        status: 'incomplete',
        summary: [{ text: 'Inspecting', type: 'summary_text' }],
        type: 'reasoning',
      },
    });
    expect(events.at(-1)).toMatchObject({
      response: {
        incomplete_details: { reason: 'max_output_tokens' },
        status: 'incomplete',
      },
      type: 'response.incomplete',
    });
  });

  it('drops thought chunks that arrive after final-answer text has started', () => {
    const mapper = createMapper();
    Array.from(mapper.processPart({ text: 'Final answer' }));

    expect([...mapper.processPart({ text: 'late thought', reasoning: true })]).toEqual([]);

    const completed = [...mapper.complete()].map(parseEvent).at(-1);
    expect(completed).toMatchObject({
      response: {
        output: [
          {
            content: [{ annotations: [], text: 'Final answer', type: 'output_text' }],
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
        toolCall: {
          arguments: { query: 'same query' },
          name: 'search_docs',
        },
      }),
      ...mapper.processPart({
        toolCall: {
          arguments: { query: 'same query' },
          name: 'search_docs',
        },
      }),
    ].map(parseEvent);

    const addedItems = events.filter((event) => event.type === 'response.output_item.added');
    expect(addedItems).toHaveLength(2);
    const ids = addedItems.map(
      (event) => z.object({ item: z.object({ call_id: z.string() }) }).parse(event).item.call_id,
    );
    expect(ids).toEqual([
      expect.stringMatching(/^call_[a-f0-9]{32}$/),
      expect.stringMatching(/^call_[a-f0-9]{32}$/),
    ]);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('preserves a function call marked as thought and stores its thought signature', () => {
    const mapper = createMapper();
    const encodedSignature = Buffer.from(
      '\x12\x26\x0a\x24' + '00000000-0000-4000-8000-000000000347',
    ).toString('base64');
    const events = [
      ...mapper.processPart({
        toolCall: {
          arguments: { command: 'pwd' },
          id: 'call_thought_1',
          name: 'shell',
        },
        reasoning: true,
        signature: encodedSignature,
      }),
    ];

    expect(events.map((event) => parseEvent(event).type)).toEqual([
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
    ]);
    expect(
      SignatureStore.getForToolCall({
        model: 'gemini-3-pro',
        sessionKey: 'openai:resp_test',
        toolCallId: 'call_thought_1',
        toolName: 'shell',
      }),
    ).toBe(encodedSignature);
    expect(SignatureStore.get({ model: 'gemini-3-pro' })).toBeNull();
  });

  it('stores thought signatures under the supplied session key', () => {
    const mapper = new OpenAIResponsesStreamingMapper({
      model: 'gemini-3-pro',
      responseId: 'resp_session_test',
      signatureMessageCount: 4,
      signatureSessionKey: 'openai:session-a',
      signatureSourceModel: 'gemini-3-pro',
    });
    const encodedSignature = Buffer.from('session a thought signature').toString('base64');

    Array.from(mapper.processPart({ reasoning: true, signature: encodedSignature }));

    expect(SignatureStore.get({ model: 'gemini-3-pro', sessionKey: 'openai:session-a' })).toBe(
      encodedSignature,
    );
    expect(
      SignatureStore.getAt({
        model: 'gemini-3-pro',
        sessionKey: 'openai:session-a',
        messageCount: 4,
      }),
    ).toBe(encodedSignature);
    expect(SignatureStore.get({ model: 'gemini-3-pro' })).toBeNull();
  });

  it('uses the physical upstream model, not the client response model, as provenance', () => {
    const mapper = new OpenAIResponsesStreamingMapper({
      model: 'gpt-4o',
      responseId: 'resp_physical_provenance',
      signatureSessionKey: 'openai:physical-model',
      signatureSourceModel: 'gemini-3-flash',
    });

    const encodedSignature = Buffer.from('physical model signature').toString('base64');
    Array.from(
      mapper.processPart({
        reasoning: true,
        signature: encodedSignature,
      }),
    );

    expect(
      SignatureStore.get({ model: 'gemini-3-flash', sessionKey: 'openai:physical-model' }),
    ).toBe(encodedSignature);
    expect(SignatureStore.get({ model: 'gpt-4o', sessionKey: 'openai:physical-model' })).toBeNull();
  });

  it('indexes a tool signature by both session and tool-call id', () => {
    const mapper = new OpenAIResponsesStreamingMapper({
      model: 'gemini-3-pro',
      responseId: 'resp_tool_signature',
      signatureMessageCount: 4,
      signatureSessionKey: 'openai:session-a',
      signatureSourceModel: 'gemini-3-pro',
    });
    const encodedSignature = Buffer.from('tool-specific signature').toString('base64');

    Array.from(
      mapper.processPart({
        toolCall: { arguments: {}, id: 'call_shared', name: 'shell' },
        signature: encodedSignature,
      }),
    );

    expect(
      SignatureStore.getForToolCall({
        model: 'gemini-3-pro',
        toolCallId: 'call_shared',
        sessionKey: 'openai:session-a',
      }),
    ).toBe(encodedSignature);
    expect(
      SignatureStore.getForToolCall({
        model: 'gemini-3-pro',
        toolCallId: 'call_shared',
        sessionKey: 'openai:session-b',
      }),
    ).toBeNull();
  });

  it('emits grounding metadata as visible Responses text', () => {
    const mapper = createMapper();
    const events = [
      ...mapper.processGrounding({
        sources: [
          {
            title: 'Gemini API documentation',
            uri: 'https://example.com/gemini',
          },
        ],
        queries: ['Gemini API'],
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

    const completed = parseEvent([...mapper.complete()].at(-1) ?? '');

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

  it('reports an interrupted stream as failed while retaining partial output', () => {
    const mapper = createMapper();
    const events = [
      ...mapper.processPart({ text: 'Partial answer' }),
      ...mapper.fail('upstream_interrupted', 'Upstream stream ended without a finish reason.'),
    ].map(parseEvent);
    expect(events.at(-1)).toMatchObject({
      response: {
        error: { code: 'upstream_interrupted' },
        output: [{ content: [{ text: 'Partial answer' }], status: 'incomplete' }],
        status: 'failed',
      },
      type: 'response.failed',
    });
    expect(events.some((event) => event.type === 'response.completed')).toBe(false);
  });
});
