import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  OpenAIResponsesSessionStoreImpl,
  mergeOpenAIResponsesInputItems,
  prepareOpenAIResponsesSessionInput,
} from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-session.store';
import { buildResponsesChatRequest } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-request';
import { toOpenAIResponsesResponse } from '@/modules/proxy-gateway/antigravity/OpenAIResponsesResponseMapper';

const fixtureText = fs.readFileSync(
  path.resolve('src/tests/fixtures/responses-format-v1/old-responses-session.json'),
  'utf8',
);
const fixture = z
  .object({
    version: z.literal(1),
    entries: z.array(
      z.object({
        key: z.string(),
        updatedAt: z.number(),
        value: z
          .object({ inputItems: z.array(z.unknown()), response: z.unknown().optional() })
          .passthrough(),
      }),
    ),
  })
  .parse(JSON.parse(fixtureText));
let directory = '';
afterEach(() => {
  vi.restoreAllMocks();
  if (directory) {
    const resolved = path.resolve(directory);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith('agm-upgrade-')
    ) {
      throw new Error('Unsafe fixture cleanup target');
    }
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    directory = '';
  }
});

describe('sessions written before reasoning format upgrade', () => {
  it('replays the exact old response and restores its tool call after a restart', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_001_000);
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-upgrade-'));
    const filePath = path.join(directory, 'sessions.json');
    fs.writeFileSync(filePath, JSON.stringify(fixture));
    const store = new OpenAIResponsesSessionStoreImpl({ filePath });
    const old = store.get('resp_before_upgrade');
    expect(old?.response).toEqual(fixture.entries[0].value.response);
    expect(old?.inputItems).toEqual(fixture.entries[0].value.inputItems);
    const items = mergeOpenAIResponsesInputItems(
      old?.inputItems ?? [],
      [
        {
          type: 'reasoning',
          id: 'reasoning_new',
          summary: [{ type: 'summary_text', text: 'New display only' }],
        },
        {
          type: 'function_call_output',
          call_id: 'call_before_upgrade',
          output: 'fixture value 41',
        },
        { role: 'user', content: 'Add one.' },
      ],
      old?.toolCallItems,
    );
    const request = buildResponsesChatRequest({
      model: old?.model,
      instructions: old?.instructions,
      tools: old?.tools,
      input: items,
    });
    expect(request.messages).toEqual([
      { role: 'system', content: 'Only use the provided safe fixture.' },
      { role: 'user', content: 'Remember fixture number 41.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_before_upgrade',
            type: 'function',
            function: { name: 'read_fixture', arguments: '{"name":"safe-fixture"}' },
          },
        ],
      },
      {
        role: 'tool',
        content: 'fixture value 41',
        tool_call_id: 'call_before_upgrade',
        name: 'read_fixture',
      },
      { role: 'user', content: 'Add one.' },
    ]);
    // GET payloads remain exact; continuation input is sanitized at the storage boundary.
    store.save('resp_after_upgrade', { model: 'gemini-3-flash', inputItems: items });
    await store.flush();
    const restarted = new OpenAIResponsesSessionStoreImpl({ filePath });
    expect(restarted.get('resp_before_upgrade')?.response).toEqual(old?.response);
    expect(JSON.stringify(restarted.get('resp_after_upgrade')?.inputItems)).not.toContain(
      'data:image/',
    );
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).version).toBe(1);
    const legacy = restarted.get('resp_legacy_inputs');
    expect(JSON.stringify(legacy?.inputItems)).not.toContain('data:image/');
    expect(
      buildResponsesChatRequest({ model: legacy?.model, input: legacy?.inputItems }).messages,
    ).toEqual([
      { role: 'user', content: '' },
      { role: 'user', content: '[historical image omitted]' },
    ]);
    expect(JSON.stringify(restarted.get('resp_legacy_inputs')?.inputItems)).not.toContain(
      'data:image/',
    );
  });
  it.each(['', ' \n\t', ' keep whitespace '])(
    'normalizes reasoning and zero usage at the JSON exit only: %j',
    (reasoning_content) => {
      const result = toOpenAIResponsesResponse({
        id: 'resp_stable',
        object: 'chat.completion',
        created: 7,
        model: 'gemini-3-flash',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: null, reasoning_content },
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
      expect(result).toEqual({
        id: 'resp_stable',
        created_at: 7,
        model: 'gemini-3-flash',
        error: null,
        incomplete_details: null,
        object: 'response',
        type: 'response',
        status: 'completed',
        output: reasoning_content.trim()
          ? [
              {
                id: 'reasoning_resp_stable',
                type: 'reasoning',
                status: 'completed',
                summary: [{ type: 'summary_text', text: reasoning_content }],
              },
            ]
          : [],
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      });
    },
  );
});

describe('Responses parent-linked session history', () => {
  const rootInput = {
    id: 'msg_root',
    type: 'message',
    role: 'user',
    content: 'root',
  };
  const rootOutput = {
    id: 'out_root',
    type: 'function_call',
    call_id: 'call_root',
    name: 'lookup',
    arguments: '{}',
  };

  it('derives replay deltas from exact, semantic-prefix, id, and semantic-suffix boundaries', () => {
    const history = [rootInput, rootOutput];
    const exact = prepareOpenAIResponsesSessionInput(history, [
      structuredClone(rootInput),
      structuredClone(rootOutput),
      { id: 'msg_exact', type: 'message', role: 'user', content: 'exact' },
    ]);
    expect(exact).toMatchObject({
      delta: [expect.objectContaining({ id: 'msg_exact' })],
      resetParent: false,
    });

    const idBoundary = prepareOpenAIResponsesSessionInput(history, [
      { ...rootOutput, arguments: '{"changed":true}' },
      { id: 'msg_boundary', type: 'message', role: 'user', content: 'boundary' },
    ]);
    expect(idBoundary.delta).toEqual([
      { id: 'msg_boundary', type: 'message', role: 'user', content: 'boundary' },
    ]);

    const semanticPrefix = prepareOpenAIResponsesSessionInput(history, [
      { ...rootInput, id: 'msg_regenerated_root' },
      { ...rootOutput, id: 'out_regenerated_root' },
      { id: 'msg_semantic', type: 'message', role: 'user', content: 'semantic' },
    ]);
    expect(semanticPrefix.delta).toEqual([
      { id: 'msg_semantic', type: 'message', role: 'user', content: 'semantic' },
    ]);
    expect(
      semanticPrefix.merged.filter((item) => Reflect.get(item as object, 'content') === 'root'),
    ).toHaveLength(1);

    const semanticSuffixOnly = prepareOpenAIResponsesSessionInput(
      [
        { type: 'message', role: 'user', content: 'first' },
        { type: 'message', role: 'user', content: 'second' },
      ],
      [
        { type: 'message', role: 'user', content: 'second' },
        { type: 'message', role: 'user', content: 'third' },
      ],
    );
    expect(semanticSuffixOnly.delta).toEqual([{ type: 'message', role: 'user', content: 'third' }]);
  });

  it('keeps semantic matching narrow and lets an explicit shared id win', () => {
    const history = [
      { id: 'first', type: 'message', role: 'user', content: 'first' },
      { id: 'second', type: 'message', role: 'user', content: 'second' },
      { id: 'third', type: 'message', role: 'assistant', content: 'third' },
    ];
    const sharedId = prepareOpenAIResponsesSessionInput(history, [
      { id: 'second', type: 'message', role: 'assistant', content: 'changed' },
      { id: 'next', type: 'message', role: 'user', content: 'next' },
    ]);
    expect(sharedId.delta).toEqual([
      { id: 'next', type: 'message', role: 'user', content: 'next' },
    ]);

    for (const mismatched of [
      { type: 'message', role: 'user', content: 'third' },
      { type: 'function_call', role: 'assistant', content: 'third' },
      { type: 'message', role: 'assistant', content: 'different' },
    ]) {
      const prepared = prepareOpenAIResponsesSessionInput(history, [
        mismatched,
        { type: 'message', role: 'user', content: 'next' },
      ]);
      expect(prepared.delta).toHaveLength(2);
    }

    const textFallback = prepareOpenAIResponsesSessionInput(
      [{ id: 'old', type: 'message', role: 'user', text: 'same' }],
      [
        { id: 'new', type: 'message', role: 'user', text: 'same' },
        { type: 'message', role: 'user', content: 'next' },
      ],
    );
    expect(textFallback.delta).toEqual([{ type: 'message', role: 'user', content: 'next' }]);
  });

  it('uses unmatched full client history as authoritative and can suppress its storage delta', () => {
    const history = [
      { type: 'message', role: 'user', content: 'old one' },
      { type: 'message', role: 'assistant', content: 'old two' },
    ];
    const replay = [
      { type: 'message', role: 'user', content: 'replacement one' },
      { type: 'message', role: 'assistant', content: 'replacement two' },
    ];

    expect(prepareOpenAIResponsesSessionInput(history, replay)).toEqual({
      delta: [replay[1]],
      merged: replay,
      resetParent: false,
    });
    expect(prepareOpenAIResponsesSessionInput(history, replay, [], false)).toEqual({
      delta: [],
      merged: replay,
      resetParent: false,
    });
  });

  it('keeps sibling branches independent after their direct parent key is deleted', () => {
    const store = new OpenAIResponsesSessionStoreImpl();
    store.saveDelta('resp_root', {
      inputDelta: [rootInput],
      model: 'gemini-3-flash',
      responseOutput: [rootOutput],
    });
    const parentA = store.getWithParent('resp_root');
    const parentB = store.getWithParent('resp_root');
    expect(parentA).not.toBeNull();
    expect(parentB).not.toBeNull();

    store.saveDelta('resp_a', {
      inputDelta: [{ id: 'msg_a', type: 'message', role: 'user', content: 'branch a' }],
      model: 'gemini-3-flash',
      parent: parentA?.parent,
      responseOutput: [{ id: 'out_a', type: 'message', role: 'assistant', content: 'answer a' }],
    });
    store.saveDelta('resp_b', {
      inputDelta: [{ id: 'msg_b', type: 'message', role: 'user', content: 'branch b' }],
      model: 'gemini-3-flash',
      parent: parentB?.parent,
      responseOutput: [{ id: 'out_b', type: 'message', role: 'assistant', content: 'answer b' }],
    });

    expect(store.delete('resp_root')).toBe(true);
    expect(
      store.get('resp_a')?.inputItems.map((item) => Reflect.get(item as object, 'id')),
    ).toEqual(['msg_root', 'out_root', 'msg_a', 'out_a']);
    expect(
      store.get('resp_b')?.inputItems.map((item) => Reflect.get(item as object, 'id')),
    ).toEqual(['msg_root', 'out_root', 'msg_b', 'out_b']);

    const mutableRead = store.get('resp_a');
    Reflect.set(mutableRead?.inputItems[0] as object, 'content', 'mutated outside the store');
    expect(Reflect.get(store.get('resp_a')?.inputItems[0] as object, 'content')).toBe('root');
  });

  it('persists child deltas and minimal ancestry across a restart', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-upgrade-'));
    const filePath = path.join(directory, 'sessions.json');
    const writer = new OpenAIResponsesSessionStoreImpl({ filePath });
    writer.saveDelta('resp_root', {
      inputDelta: [rootInput],
      model: 'gemini-3-flash',
      responseOutput: [rootOutput],
    });
    const root = writer.getWithParent('resp_root');
    writer.saveDelta('resp_child', {
      inputDelta: [{ id: 'msg_child', type: 'message', role: 'user', content: 'child' }],
      model: 'gemini-3-flash',
      parent: root?.parent,
      response: { id: 'resp_child', object: 'response', output: [] },
      responseOutput: [
        { id: 'out_child', type: 'message', role: 'assistant', content: 'answer child' },
      ],
    });
    expect(writer.delete('resp_root')).toBe(true);
    await writer.flush();

    const envelope = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      entries: Array<{ key: string; value: Record<string, unknown> }>;
    };
    const child = envelope.entries.find((entry) => entry.key === 'resp_child')?.value;
    expect(Reflect.get(Reflect.get(child ?? {}, 'node') as object, 'inputDelta')).toHaveLength(1);
    expect(Reflect.get(Reflect.get(child ?? {}, 'node') as object, 'responseOutput')).toHaveLength(
      1,
    );
    expect(
      JSON.stringify(Reflect.get(Reflect.get(child ?? {}, 'node') as object, 'parent')),
    ).not.toContain('"response"');

    const restarted = new OpenAIResponsesSessionStoreImpl({ filePath });
    expect(restarted.get('resp_root')).toBeNull();
    expect(
      restarted.get('resp_child')?.inputItems.map((item) => Reflect.get(item as object, 'id')),
    ).toEqual(['msg_root', 'out_root', 'msg_child', 'out_child']);
    expect(restarted.get('resp_child')?.response?.id).toBe('resp_child');
  });

  it('starts a new storage root when compaction resets history', () => {
    const prepared = prepareOpenAIResponsesSessionInput(
      [rootInput, rootOutput],
      [
        { type: 'compaction', encrypted_content: 'opaque' },
        { id: 'msg_compacted', type: 'message', role: 'user', content: 'summary' },
      ],
    );
    expect(prepared.resetParent).toBe(true);
    expect(prepared.merged).toEqual([
      { id: 'msg_compacted', type: 'message', role: 'user', content: 'summary' },
    ]);
    expect(prepared.delta).toEqual(prepared.merged);
  });
});
