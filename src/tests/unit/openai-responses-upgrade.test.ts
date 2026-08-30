import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  OpenAIResponsesSessionStoreImpl,
  mergeOpenAIResponsesInputItems,
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
    // Storage retains raw protocol items; parser normalization never rewrites old GET payloads.
    store.save('resp_after_upgrade', { model: 'gemini-3-flash', inputItems: items });
    await store.flush();
    const restarted = new OpenAIResponsesSessionStoreImpl({ filePath });
    expect(restarted.get('resp_before_upgrade')?.response).toEqual(old?.response);
    expect(restarted.get('resp_after_upgrade')?.inputItems).toEqual(items);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).version).toBe(1);
    const legacy = restarted.get('resp_legacy_inputs');
    expect(
      buildResponsesChatRequest({ model: legacy?.model, input: legacy?.inputItems }).messages,
    ).toEqual([
      { role: 'user', content: 'Legacy empty type.' },
      { role: 'user', content: '{"legacy":"object content"}' },
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }],
      },
    ]);
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
