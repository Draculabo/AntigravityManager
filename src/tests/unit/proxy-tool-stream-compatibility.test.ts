import { PassThrough, Readable } from 'node:stream';
import { Observable } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { MALFORMED_FUNCTION_CALL_RECOVERY_TEXT } from '@/modules/proxy-gateway/antigravity/GeminiFinishReason';
import type { OpenAIChatRequest } from '@/server/gateway/common/interfaces/request-interfaces';
import { proxyModelAvailabilityStore } from '@/server/gateway/shared/services/model-availability.service';
import {
  collect,
  createAccount,
  createGateway,
  createLease,
  createUpstream,
  geminiStreamFrame,
} from './proxy-real-path.harness';

vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<typeof import('@/server/gateway/common/utils/request-user-agent')>()),
  resolveRequestUserAgent: async () => 'protocol-compatibility-test',
}));

const Usage = z
  .object({ prompt_tokens: z.number(), completion_tokens: z.number(), total_tokens: z.number() })
  .passthrough();
const ChatChunk = z
  .object({
    choices: z
      .array(
        z
          .object({
            finish_reason: z.string().nullable(),
            delta: z
              .object({
                content: z.string().nullable().optional(),
                tool_calls: z
                  .array(
                    z
                      .object({
                        id: z.string(),
                        function: z.object({ name: z.string(), arguments: z.string() }),
                      })
                      .passthrough(),
                  )
                  .optional(),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .optional(),
    usage: Usage.nullable().optional(),
    error: z.object({ code: z.string() }).passthrough().optional(),
  })
  .passthrough();

function chunks(sse: string) {
  return sse
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => ChatChunk.parse(JSON.parse(line.slice(6))));
}

const usageMetadata = { promptTokenCount: 11, candidatesTokenCount: 4, totalTokenCount: 15 };
const usage = { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 };
const request: OpenAIChatRequest = {
  model: 'gemini-3-flash',
  messages: [{ role: 'user', content: 'Protocol probe.' }],
  stream: true,
};
const args = {
  cmd: 'original input',
  code: 'original code',
  description: 'client description',
  metadata: { source: 'client' },
  workflow: [{ input: 'step input' }],
};
const toolCall = { name: 'powershell', id: 'call_preserved', args };
const terminal = (finishReason = 'STOP', parts = [{ text: 'Existing text.' }]) =>
  geminiStreamFrame({ candidates: [{ content: { role: 'model', parts }, finishReason }] });

async function chat(frames: unknown[], options?: OpenAIChatRequest['stream_options']) {
  const upstream = createUpstream({ streamFrames: frames });
  const service = createGateway(upstream, createLease([createAccount('acc-1')])).openAIService;
  const result = await service.handleChatCompletions({ ...request, stream_options: options });
  expect(result).toBeInstanceOf(Observable);
  if (!(result instanceof Observable)) {
    throw new Error('Expected a stream');
  }
  return { sse: await collect(result), upstream };
}

describe('stream options and tool failure through production request paths', () => {
  afterEach(() => {
    proxyModelAvailabilityStore.clearAccount('acc-1');
    vi.restoreAllMocks();
  });

  it.each([undefined, null, {}, { include_usage: false }])(
    'preserves finish-chunk usage by default (%j)',
    async (options) => {
      const { sse } = await chat(
        [
          geminiStreamFrame({
            usageMetadata,
            candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          }),
        ],
        options,
      );
      const events = chunks(sse);
      expect(events.filter((event) => event.choices?.length === 0)).toEqual([]);
      expect(events.at(-1)).toMatchObject({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage,
      });
      expect(sse.match(/data: \[DONE\]/g)).toHaveLength(1);
    },
  );

  it.each(['same frame', 'late trailer'])(
    'emits one independent usage block for %s',
    async (location) => {
      const frames =
        location === 'same frame'
          ? [
              geminiStreamFrame({
                usageMetadata,
                candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
              }),
            ]
          : [terminal(), geminiStreamFrame({ usageMetadata })];
      const { sse } = await chat(frames, { include_usage: true });
      const events = chunks(sse);
      expect(events.slice(0, -1).every((event) => event.usage === null)).toBe(true);
      expect(events.filter((event) => event.usage !== null)).toEqual([
        expect.objectContaining({ choices: [], usage }),
      ]);
      expect(events.at(-2)?.choices?.[0]?.finish_reason).toBe('stop');
      expect(sse.endsWith('data: [DONE]\n\n')).toBe(true);
      expect(sse.match(/data: \[DONE\]/g)).toHaveLength(1);
    },
  );

  it('does not fabricate a usage block when upstream has no usage', async () => {
    const { sse } = await chat([terminal()], { include_usage: true });
    expect(chunks(sse).every((event) => event.usage === null)).toBe(true);
    expect(sse.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('rejects invalid stream options before leasing an account or calling upstream', async () => {
    const upstream = createUpstream({ streamFrames: [] });
    const lease = createLease([createAccount('acc-1')]);
    const service = createGateway(upstream, lease).openAIService;
    const invalid = { ...request, stream_options: { include_usage: 'true' } };
    await expect(
      service.handleChatCompletions(invalid as unknown as OpenAIChatRequest),
    ).rejects.toThrow('include_usage must be a boolean');
    expect(lease.getNextToken).not.toHaveBeenCalled();
    expect(upstream.calls).toEqual([]);
  });

  it('preserves partial text and observed usage when upstream ends without a terminal reason', async () => {
    const { sse, upstream } = await chat(
      [
        geminiStreamFrame({
          candidates: [{ content: { parts: [{ text: 'partial' }] } }],
          usageMetadata,
        }),
      ],
      { include_usage: true },
    );
    const events = chunks(sse);
    const choices = events.flatMap((event) => event.choices ?? []);
    expect(choices.map((choice) => choice.delta.content ?? '').join('')).toBe('partial');
    expect(choices.flatMap((choice) => choice.finish_reason ?? [])).toEqual(['length']);
    expect(events.at(-2)).toMatchObject({
      choices: [{ delta: {}, finish_reason: 'length' }],
      usage: null,
    });
    expect(events.at(-1)).toMatchObject({ choices: [], usage });
    expect(events.flatMap((event) => event.usage ?? [])).toEqual([usage]);
    expect(events.every((event) => event.error === undefined)).toBe(true);
    expect(sse.endsWith('data: [DONE]\n\n')).toBe(true);
    expect(sse.match(/^data: \[DONE\]$/gm)).toHaveLength(1);
    expect(upstream.streamGenerateInternal).toHaveBeenCalledTimes(1);
    expect(upstream.generateInternal).not.toHaveBeenCalled();
  });

  it('does not present final usage after a transport error following the finish frame', async () => {
    const upstream = createUpstream({ streamFrames: [] });
    upstream.streamGenerateInternal.mockImplementation(async () =>
      Readable.from(
        (async function* () {
          yield Buffer.from(`data: ${JSON.stringify(terminal())}\n\n`);
          yield Buffer.from(`data: ${JSON.stringify(geminiStreamFrame({ usageMetadata }))}\n\n`);
          throw new Error('controlled interruption');
        })(),
      ),
    );
    const result = await createGateway(
      upstream,
      createLease([createAccount('acc-1')]),
    ).openAIService.handleChatCompletions({ ...request, stream_options: { include_usage: true } });
    if (!(result instanceof Observable)) {
      throw new Error('Expected a stream');
    }
    const sse = await collect(result);
    expect(chunks(sse).at(-1)).toMatchObject({ error: { code: 'upstream_stream_error' } });
    expect(chunks(sse).some((event) => event.choices?.length === 0)).toBe(false);
    expect(sse).not.toContain('[DONE]');
    expect(upstream.calls).toHaveLength(0);
    expect(upstream.streamGenerateInternal).toHaveBeenCalledTimes(1);
    expect(upstream.generateInternal).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'preserves valid tools and adds a failure explanation with include_usage=%s',
    async (includeUsage) => {
      const { sse, upstream } = await chat(
        [
          geminiStreamFrame({
            candidates: [
              { content: { parts: [{ text: 'Existing text.' }, { functionCall: toolCall }] } },
            ],
          }),
          terminal('MALFORMED_FUNCTION_CALL', []),
          geminiStreamFrame({ usageMetadata }),
        ],
        { include_usage: includeUsage },
      );
      const events = chunks(sse);
      const tools = events.flatMap(
        (event) => event.choices?.flatMap((choice) => choice.delta.tool_calls ?? []) ?? [],
      );
      expect(tools).toEqual([
        {
          index: 0,
          id: 'call_preserved',
          type: 'function',
          function: { name: 'powershell', arguments: JSON.stringify(args) },
        },
      ]);
      expect(
        events
          .flatMap((event) => event.choices?.map((choice) => choice.delta.content ?? '') ?? [])
          .join(''),
      ).toBe(`Existing text.\n\n${MALFORMED_FUNCTION_CALL_RECOVERY_TEXT}`);
      expect(
        events.find((event) => event.choices?.[0]?.finish_reason)?.choices?.[0]?.finish_reason,
      ).toBe('tool_calls');
      expect(upstream.calls).toHaveLength(1);
      if (includeUsage) {
        expect(events.at(-1)).toMatchObject({ choices: [], usage });
      }
    },
  );

  it('preserves tools and the independent usage block in unary fallback streams', async () => {
    const upstream = createUpstream({
      streamError: new Error('controlled stream setup failure'),
      generate: {
        candidates: [
          {
            content: { parts: [{ text: 'Existing text.' }, { functionCall: toolCall }] },
            finishReason: 'MALFORMED_FUNCTION_CALL',
          },
        ],
        usageMetadata,
      },
    });
    const result = await createGateway(
      upstream,
      createLease([createAccount('acc-1')]),
    ).openAIService.handleChatCompletions({ ...request, stream_options: { include_usage: true } });
    if (!(result instanceof Observable)) {
      throw new Error('Expected a stream');
    }
    const events = chunks(await collect(result));
    expect(
      events.flatMap(
        (event) => event.choices?.flatMap((choice) => choice.delta.tool_calls ?? []) ?? [],
      ),
    ).toEqual([
      {
        index: 0,
        id: 'call_preserved',
        type: 'function',
        function: { name: 'powershell', arguments: JSON.stringify(args) },
      },
    ]);
    expect(events.slice(0, -1).every((event) => event.usage === null)).toBe(true);
    expect(events.at(-1)).toMatchObject({ choices: [], usage });
    expect(
      events
        .flatMap((event) => event.choices?.map((choice) => choice.delta.content ?? '') ?? [])
        .join(''),
    ).toBe(`Existing text.\n\n${MALFORMED_FUNCTION_CALL_RECOVERY_TEXT}`);
    expect(upstream.streamGenerateInternal).toHaveBeenCalledTimes(1);
    expect(upstream.generateInternal).toHaveBeenCalledTimes(1);
  });

  it('does not fabricate usage when unary fallback has no upstream statistics', async () => {
    const upstream = createUpstream({
      streamError: new Error('controlled setup failure'),
      generate: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] },
    });
    const result = await createGateway(
      upstream,
      createLease([createAccount('acc-1')]),
    ).openAIService.handleChatCompletions({ ...request, stream_options: { include_usage: true } });
    if (!(result instanceof Observable)) {
      throw new Error('Expected a stream');
    }
    const sse = await collect(result);
    expect(chunks(sse).every((event) => event.usage === null)).toBe(true);
    expect(sse.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('does not emit final usage after the client unsubscribes', async () => {
    const source = new PassThrough();
    const upstream = createUpstream({ streamFrames: [] });
    upstream.streamGenerateInternal.mockResolvedValue(source);
    const result = await createGateway(
      upstream,
      createLease([createAccount('acc-1')]),
    ).openAIService.handleChatCompletions({ ...request, stream_options: { include_usage: true } });
    if (!(result instanceof Observable)) {
      throw new Error('Expected a stream');
    }
    const received: string[] = [];
    const finish = Promise.withResolvers<void>();
    const subscription = result.subscribe({
      next: (chunk) => {
        received.push(chunk);
        if (chunks(chunk).some((event) => event.choices?.[0]?.finish_reason === 'stop')) {
          finish.resolve();
        }
      },
      error: finish.reject,
    });
    try {
      source.write(`data: ${JSON.stringify(terminal())}\n\n`);
      await finish.promise;
      subscription.unsubscribe();
      expect(source.destroyed).toBe(true);

      // Simulate data already queued by the provider when the client disconnected.
      source.emit(
        'data',
        Buffer.from(`data: ${JSON.stringify(geminiStreamFrame({ usageMetadata }))}\n\n`),
      );
      source.emit('end');
      expect(chunks(received.join('')).at(-1)?.choices?.[0]?.finish_reason).toBe('stop');
      expect(chunks(received.join('')).every((event) => event.usage === null)).toBe(true);
      expect(received.join('')).not.toContain('[DONE]');
    } finally {
      subscription.unsubscribe();
      source.destroy();
    }
  });
});
