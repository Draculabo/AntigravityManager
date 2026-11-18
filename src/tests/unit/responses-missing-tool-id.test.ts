import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildResponsesChatRequest } from '@/server/gateway/modules/openai/responses/openai-responses-request';
import { prepareOpenAIResponsesSessionInput } from '@/server/gateway/modules/openai/responses/responses-session-input';
import { OpenAIResponsesSessionStoreImpl } from '@/server/gateway/modules/openai/responses/openai-responses-session.store';
import { responsesIdentityFixture } from './responses-identity.fixture';
import { PIXEL_PNG } from '../fixtures/image-content';

const call = { type: 'function_call', name: 'read', arguments: '{"a":1,"b":2}' };
const prompt = { type: 'message', role: 'user', content: 'Read the fixture.' };
const result = { type: 'function_call_output', output: 'done' };
function toolIds(input: unknown[]): string[] {
  return buildResponsesChatRequest({ input }).messages.flatMap(
    (message) => message.tool_calls?.map((tool) => tool.id) ?? [],
  );
}

describe('Responses deterministic missing tool IDs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
  });
  afterEach(() => vi.useRealTimers());

  it('keeps the same ID when the same history is mapped at different times', () => {
    const first = toolIds([prompt, call]);
    vi.setSystemTime(2000);
    expect(toolIds([prompt, call])).toEqual(first);
    expect(first[0]).toMatch(/^call_[a-f0-9]{32}$/);
  });

  it('gives identical parallel calls distinct stable IDs even within one millisecond', () => {
    const ids = toolIds([prompt, call, { ...call }]);
    expect(new Set(ids).size).toBe(2);
    expect(toolIds([prompt, call, { ...call }])).toEqual(ids);
  });

  it('hashes canonical parsed arguments rather than JSON property order', () => {
    expect(toolIds([prompt, call])).toEqual(
      toolIds([prompt, { ...call, arguments: '{"b":2,"a":1}' }]),
    );
    expect(toolIds([prompt, call])).not.toEqual(
      toolIds([prompt, { ...call, arguments: '{"b":3,"a":1}' }]),
    );
  });

  it('distinguishes causal text changes in the middle of equal-length prompts', () => {
    const prefix = 'x'.repeat(100);
    const suffix = 'y'.repeat(100);
    expect(toolIds([{ ...prompt, content: `${prefix}A${suffix}` }, call])).not.toEqual(
      toolIds([{ ...prompt, content: `${prefix}B${suffix}` }, call]),
    );
  });

  it('binds a missing-ID result to its single preceding pending call', () => {
    const messages = buildResponsesChatRequest({ input: [prompt, call, result] }).messages;
    expect(messages[2]).toEqual({
      role: 'tool',
      tool_call_id: messages[1]?.tool_calls?.[0]?.id,
      name: 'read',
      content: 'done',
    });
  });

  it('rejects a missing-ID result when parallel calls leave the association ambiguous', () => {
    expect(() =>
      buildResponsesChatRequest({ input: [prompt, call, { ...call, name: 'write' }, result] }),
    ).toThrow('Invalid tool history at input[3]: ambiguous-missing-id.');
  });

  it('preserves explicit IDs and input objects', () => {
    const items = [prompt, { ...call, call_id: 'client.id' }, { ...result, call_id: 'client.id' }];
    const original = structuredClone(items);
    expect(toolIds(items)).toEqual(['client.id']);
    expect(items).toEqual(original);
  });

  it('materializes generated IDs while retaining original image history', () => {
    const store = new OpenAIResponsesSessionStoreImpl();
    const image = {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_image', image_url: `data:image/png;base64,${PIXEL_PNG.toString('base64')}` },
      ],
    };
    const prepared = prepareOpenAIResponsesSessionInput([], [image, call]);
    const id = toolIds(prepared.merged)[0];
    expect(prepared.delta[1]).toEqual({ ...call, call_id: id });
    store.saveDelta('first', {
      identity: responsesIdentityFixture,
      model: 'fixture',
      inputDelta: prepared.delta,
      responseOutput: [],
    });
    const parent = store.get('first');
    if (!parent) {
      throw new Error('Missing fixture parent');
    }
    expect(parent.inputItems).toEqual(prepared.delta);
    const continued = prepareOpenAIResponsesSessionInput(parent.inputItems, [result]);
    expect(toolIds(continued.merged)).toEqual([id]);
    expect(continued.delta).toEqual([{ ...result, call_id: id }]);
    store.clear();
  });

  it('materializes distinct IDs for repeated references without mutating the source', () => {
    const prepared = prepareOpenAIResponsesSessionInput([], [prompt, call, call]);
    const ids = toolIds(prepared.merged);
    expect(new Set(ids).size).toBe(2);
    expect(prepared.delta).toEqual([
      prompt,
      { ...call, call_id: ids[0] },
      { ...call, call_id: ids[1] },
    ]);
    expect(call).not.toHaveProperty('call_id');
  });
});
