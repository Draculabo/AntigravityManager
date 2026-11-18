import { describe, expect, it } from 'vitest';
import { buildResponsesChatRequest } from '@/server/gateway/modules/openai/responses/openai-responses-request';
import {
  collectResponsesToolCallItems,
  mergeOpenAIResponsesInputItems,
  prepareOpenAIResponsesSessionInput,
} from '@/server/gateway/modules/openai/responses/responses-session-input';
import { OpenAIResponsesWebSocketProtocol } from '@/server/gateway/modules/openai/responses/openai-responses-websocket.protocol';

const call = (name = 'read') => ({
  type: 'function_call',
  call_id: 't',
  name,
  arguments: '{}',
});
const result = { type: 'function_call_output', call_id: 't', output: 'done' };
const prompt = { type: 'message', role: 'user', content: 'Continue.' };

describe('Responses tool history repair', () => {
  it('preserves a complete leading tool round after system instructions', () => {
    expect(
      buildResponsesChatRequest({ instructions: 'Be precise.', input: [call(), result, prompt] })
        .messages,
    ).toEqual([
      { role: 'system', content: 'Be precise.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 't', type: 'function', function: { name: 'read', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 't', name: 'read', content: 'done' },
      { role: 'user', content: 'Continue.' },
    ]);
  });

  it.each(['function_call_output', 'custom_tool_call_output'])(
    'rejects an orphan %s without erasing its evidence',
    (type) => {
      expect(() => buildResponsesChatRequest({ input: [{ ...result, type }, prompt] })).toThrow(
        'Invalid tool history at input[0]: missing-pending-call.',
      );
    },
  );

  it('rejects a repeated custom result after consuming its call', () => {
    const custom = { type: 'custom_tool_call', call_id: 't', name: 'command', input: 'ls' };
    const output = { ...result, type: 'custom_tool_call_output' };
    expect(() => buildResponsesChatRequest({ input: [prompt, custom, output, output] })).toThrow(
      'Invalid tool history at input[3]: missing-pending-call.',
    );
  });

  it('does not suppress an earlier cached call because its ID is reused later', () => {
    const old = call();
    const next = call('write');
    expect(mergeOpenAIResponsesInputItems([], [result, next, result], [old])).toEqual([
      old,
      result,
      next,
      result,
    ]);
  });

  it('rejects ambiguous cached calls rather than choosing by array order', () => {
    expect(() => mergeOpenAIResponsesInputItems([], [result], [call(), call('write')])).toThrow(
      'Invalid tool history at input[0]: ambiguous-cached-call.',
    );
  });

  it('does not restore a consumed call for a duplicate result', () => {
    const items = mergeOpenAIResponsesInputItems([], [prompt, call(), result, result], [call()]);
    expect(() => buildResponsesChatRequest({ input: items })).toThrow(
      'Invalid tool history at input[3]: missing-pending-call.',
    );
  });

  it('does not delete an earlier call when two durable item IDs conflict', () => {
    expect(() =>
      mergeOpenAIResponsesInputItems(
        [],
        [prompt, { ...call(), id: 'item' }, result, { ...call('write'), id: 'item' }, result],
      ),
    ).toThrow('Invalid tool history at input[3]: conflicting-item-id.');
  });

  it('deduplicates an exact durable-item replay at its original position', () => {
    const item = { ...call(), id: 'item' };
    expect(mergeOpenAIResponsesInputItems([], [prompt, item, result, { ...item }])).toEqual([
      prompt,
      item,
      result,
    ]);
  });

  it('retains conflicting cache candidates so later repair cannot mistake them for unique', () => {
    const first = call();
    const second = call('write');
    expect(collectResponsesToolCallItems([first, second, { ...first }])).toEqual([first, second]);
  });

  it('bounds ambiguity evidence while retaining all calls in the full history', () => {
    const calls = Array.from({ length: 100 }, (_, index) => call(`read_${index}`));
    expect(collectResponsesToolCallItems(calls)).toEqual(calls.slice(0, 2));
    const transcript = calls.flatMap((item) => [item, result]);
    expect(mergeOpenAIResponsesInputItems([], transcript, calls.slice(0, 2))).toEqual(transcript);
  });

  it('does not mistake different tool arguments in a full transcript for a semantic replay', () => {
    const old = call();
    const changed = { ...old, arguments: '{"path":"other"}' };
    expect(
      prepareOpenAIResponsesSessionInput([prompt, old, result], [prompt, changed, result]).merged,
    ).toEqual([prompt, changed, result]);
  });

  it('rejects ambiguous socket-cache recovery after compaction without replacing state', async () => {
    const protocol = new OpenAIResponsesWebSocketProtocol();
    await protocol.accept({ type: 'response.create', model: 'fixture', input: [] });
    protocol.complete({ id: 'first', output: [call()] });
    await protocol.accept({ type: 'response.append', input: [{ type: 'compaction' }, prompt] });
    protocol.complete({ id: 'second', output: [call('write')] });
    await protocol.accept({ type: 'response.append', input: [{ type: 'compaction' }, prompt] });
    await expect(protocol.accept({ type: 'response.append', input: [result] })).rejects.toThrow(
      'Invalid tool history at input[1]: ambiguous-cached-call.',
    );
    expect(await protocol.accept({ type: 'response.append', input: [] })).toEqual({
      kind: 'request',
      request: { model: 'fixture', input: [prompt], stream: true },
    });
  });
});
