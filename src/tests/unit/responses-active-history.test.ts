import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIResponsesWebSocketProtocol } from '@/server/gateway/modules/openai/responses/openai-responses-websocket.protocol';
import { mergeOpenAIResponsesInputItems } from '@/server/gateway/modules/openai/responses/openai-responses-session.store';

async function input(protocol: OpenAIResponsesWebSocketProtocol, items: unknown[]) {
  const action = await protocol.accept({ type: 'response.append', input: items });
  if (action.kind !== 'request') {
    throw new Error('Expected generation');
  }
  return action.request.input;
}

describe('active Responses history ownership', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not reintroduce an old completion after compaction and failed generation', async () => {
    const protocol = new OpenAIResponsesWebSocketProtocol();
    protocol.accept({ type: 'response.create', model: 'fixture', input: [] });
    protocol.complete({
      id: 'old',
      output: [{ id: 'old-answer', type: 'message', role: 'assistant', content: 'old answer' }],
    });
    const summary = { type: 'message', role: 'user', content: 'summary' };
    expect(await input(protocol, [{ type: 'compaction' }, summary])).toEqual([summary]);
    const next = { type: 'message', role: 'user', content: 'next' };
    expect(await input(protocol, [next])).toEqual([summary, next]);
  });

  it('merges an ID-less completion only once across generation failures', async () => {
    const protocol = new OpenAIResponsesWebSocketProtocol();
    protocol.accept({ type: 'response.create', model: 'fixture', input: [] });
    const output = { type: 'message', role: 'assistant', content: 'answer' };
    protocol.complete({ id: 'old', output: [output] });
    const one = { type: 'message', role: 'user', content: 'one' };
    const two = { type: 'message', role: 'user', content: 'two' };
    expect(await input(protocol, [one])).toEqual([output, one]);
    expect(await input(protocol, [two])).toEqual([output, one, two]);
  });

  it('does not enumerate historical tool calls to repair one late result', async () => {
    const protocol = new OpenAIResponsesWebSocketProtocol();
    protocol.accept({ type: 'response.create', model: 'fixture', input: [] });
    const calls = Array.from({ length: 100 }, (_, index) => ({
      type: 'function_call',
      call_id: `call-${index}`,
      name: 'lookup',
      arguments: JSON.stringify({ index }),
    }));
    for (let index = 0; index < calls.length; index++) {
      protocol.complete({ id: String(index), output: [calls[index]] });
      await input(protocol, [
        { type: 'compaction' },
        { type: 'message', role: 'user', content: 'summary' },
      ]);
    }
    protocol.complete({ id: 'empty', output: [] });
    const cache: unknown = Reflect.get(protocol, 'toolCallItems');
    if (!(cache instanceof Map)) {
      throw new Error('Expected indexed tool cache');
    }
    const values = vi.spyOn(cache, 'values');
    const result = { type: 'function_call_output', call_id: 'call-0', output: 'done' };
    expect(await input(protocol, [result])).toEqual([
      { type: 'message', role: 'user', content: 'summary' },
      calls[0],
      result,
    ]);
    expect(values).not.toHaveBeenCalled();
  });

  it('keeps completion available when compaction preflight rejects the request', async () => {
    const protocol = new OpenAIResponsesWebSocketProtocol((request) => {
      if (request.model === 'invalid') {
        throw new Error('fixture preflight failed');
      }
    });
    protocol.accept({ type: 'response.create', model: 'fixture', input: [] });
    const output = { id: 'answer', type: 'message', role: 'assistant', content: 'answer' };
    protocol.complete({ id: 'completed', output: [output] });
    await expect(
      protocol.accept({
        type: 'response.append',
        model: 'invalid',
        input: [{ type: 'compaction' }],
      }),
    ).rejects.toThrow('fixture preflight failed');
    const next = { type: 'message', role: 'user', content: 'continue' };
    expect(await input(protocol, [next])).toEqual([output, next]);
  });

  it('does not restore a completion discarded by complete transcript replacement', async () => {
    const protocol = new OpenAIResponsesWebSocketProtocol();
    protocol.accept({ type: 'response.create', model: 'fixture', input: [] });
    protocol.complete({
      id: 'old',
      output: [{ id: 'old-answer', type: 'message', role: 'assistant', content: 'old' }],
    });
    const replacement = { role: 'assistant', content: 'replacement' };
    protocol.accept({ type: 'response.append', model: 'fixture', input: [replacement] });
    const next = { type: 'message', role: 'user', content: 'continue' };
    expect(await input(protocol, [next])).toEqual([replacement, next]);
  });

  it('repairs a unique indexed or array candidate and rejects conflicting array candidates', () => {
    const old = { type: 'custom_tool_call', id: 'custom', name: 'command', input: 'old' };
    const latest = { ...old, input: 'latest' };
    const output = { type: 'custom_tool_call_output', call_id: 'custom', output: 'done' };
    const expected = [latest, output];
    expect(mergeOpenAIResponsesInputItems([], [output], [latest, { ...latest }])).toEqual(expected);
    expect(() => mergeOpenAIResponsesInputItems([], [output], [old, latest])).toThrow(
      'Invalid tool history at input[0]: ambiguous-cached-call.',
    );
    expect(mergeOpenAIResponsesInputItems([], [output], new Map([['custom', latest]]))).toEqual(
      expected,
    );
  });
});
