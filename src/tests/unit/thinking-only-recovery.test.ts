import { performance } from 'node:perf_hooks';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ThinkingOnlyRecovery,
  recoverThinkingOnlyStream,
  combineRecoveryUsage,
} from '@/server/gateway/common/thinking-only-recovery';
import { getStreamOutputRetainedBytes } from '@/server/gateway/common/stream-output-budget';
import type { GeminiInternalRequest } from '@/modules/proxy-gateway/antigravity/types';
import type { GeminiResponse } from '@/server/gateway/common/interfaces/request-interfaces';
import { isTerminalGenerationFailure } from '@/modules/proxy-gateway/antigravity/UpstreamGenerationError';
import {
  decodeInternalSseData,
  IncrementalSseDataParser,
} from '@/modules/proxy-gateway/antigravity/internal-sse';
import {
  GenerationDeadlineScope,
  generationDeadlineAt,
  admitUpstreamGenerationSend,
  LARGE_GENERATION_SEND_BYTES,
} from '@/server/gateway/common/generation-deadline';

const wire = (response: GeminiResponse) => Buffer.from(`data: ${JSON.stringify({ response })}\n\n`);
const thought: GeminiResponse = {
  candidates: [
    {
      content: { role: 'model', parts: [{ thought: true, text: 'reasoning' }] },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
};
const answer: GeminiResponse = {
  candidates: [{ content: { role: 'model', parts: [{ text: 'answer' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
};

function fixture(deadlineAt = performance.now() + 10000) {
  const request: GeminiInternalRequest = {
    model: 'controlled-model',
    requestId: 'parent-controlled-id',
    userAgent: 'controlled/0.0.0',
    request: {
      contents: [{ role: 'user', parts: [{ text: '请回答问题' }] }],
      generationConfig: { thinkingConfig: { thinkingBudget: 8192, includeThoughts: true } },
      tools: [{ functionDeclarations: [{ name: 'read_probe', parameters: { type: 'OBJECT' } }] }],
    },
  };
  const snapshot = structuredClone(request);
  const budget = { attempted: false, deadlineAt, thinkingOnlyAttempted: false };
  const recovery = new ThinkingOnlyRecovery(request, budget, {
    current: {
      baseUrl: 'https://controlled.invalid',
      proxy: false,
      headers: { 'User-Agent': 'controlled/0.0.0' },
    },
  });
  return { recovery, request, snapshot, budget };
}
async function collect(stream: Readable) {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(String(chunk));
  }
  return chunks.join('');
}
afterEach(() => {
  vi.restoreAllMocks();
  expect(getStreamOutputRetainedBytes()).toBe(0);
});

it('clones history, uses a new child ID and a local language cue, without changing the original', async () => {
  const { recovery, request, snapshot, budget } = fixture();
  const send = vi.fn(async (body: GeminiInternalRequest) => body);
  try {
    const child = await recovery.invoke(send);
    expect(request).toEqual(snapshot);
    expect(child.request.contents).toEqual([
      { role: 'user', parts: [{ text: '请回答问题' }, { text: '继续。' }] },
    ]);
    expect(child.requestId).not.toBe(snapshot.requestId);
    expect(child).toEqual({
      ...snapshot,
      requestId: expect.any(String),
      request: {
        ...snapshot.request,
        contents: [{ role: 'user', parts: [{ text: '请回答问题' }, { text: '继续。' }] }],
      },
    });
    expect(budget.thinkingOnlyAttempted).toBe(true);
    await expect(recovery.invoke(send)).rejects.toMatchObject({ code: 'empty_thinking_response' });
    expect(send).toHaveBeenCalledOnce();
  } finally {
    recovery.close();
  }
});

it('keeps continuation cancellation inside the same deadline and send-admission owner', async () => {
  const { recovery } = fixture();
  const owner = new GenerationDeadlineScope(10_000);
  for (let index = 0; index < 3; index++) {
    admitUpstreamGenerationSend(owner.signal, LARGE_GENERATION_SEND_BYTES);
  }
  try {
    const output = recoverThinkingOnlyStream(
      Readable.from([wire(thought)]),
      recovery,
      async (_body, _timeout, _transport, signal) => {
        expect(generationDeadlineAt(signal)).toBe(owner.deadlineAt);
        if (!signal) {
          throw new Error('Expected the continuation cancellation signal');
        }
        admitUpstreamGenerationSend(signal, LARGE_GENERATION_SEND_BYTES);
        return Readable.from([wire(answer)]);
      },
      owner.signal,
    );
    await expect(collect(output)).rejects.toMatchObject({ code: 'generation_replay_limit' });
  } finally {
    owner.dispose();
    recovery.close();
  }
});

it.each(['deadline', 'cancelled'] as const)('does not dispatch when %s', async (kind) => {
  const { recovery } = fixture(kind === 'deadline' ? performance.now() - 1 : undefined);
  const controller = new AbortController();
  if (kind === 'cancelled') {
    controller.abort();
  }
  const send = vi.fn();
  try {
    await expect(recovery.invoke(send, controller.signal)).rejects.toBeInstanceOf(Error);
    expect(send).not.toHaveBeenCalled();
  } finally {
    recovery.close();
  }
});

describe('continuation eligibility', () => {
  it.each([
    { ...thought, candidates: [{ ...thought.candidates![0], finishReason: 'SAFETY' }] },
    { ...thought, candidates: [{ ...thought.candidates![0], finishReason: 'MAX_TOKENS' }] },
    {
      ...thought,
      candidates: [{ ...thought.candidates![0], finishReason: 'MALFORMED_FUNCTION_CALL' }],
    },
    { promptFeedback: { blockReason: 'SAFETY' } },
    {
      candidates: [
        {
          content: { role: 'model', parts: [{ functionCall: { name: 'read_file', args: {} } }] },
          finishReason: 'STOP',
        },
      ],
    },
    {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ inlineData: { mimeType: 'image/png', data: 'eA==' } }],
          },
          finishReason: 'STOP',
        },
      ],
    },
    answer,
  ] satisfies GeminiResponse[])(
    'does not heal refusal, truncation, tools, media or visible output: %j',
    async (response) => {
      const { recovery } = fixture();
      const send = vi.fn();
      const output = await collect(
        recoverThinkingOnlyStream(Readable.from([wire(response)]), recovery, send),
      );
      expect(output).toContain(JSON.stringify(response));
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('does not combine candidates to qualify for recovery', async () => {
    const { recovery } = fixture();
    const send = vi.fn();
    const source = Readable.from([
      wire({
        candidates: [
          { content: { role: 'model', parts: [{ thought: true, text: 'reasoning' }] } },
          { finishReason: 'STOP' },
        ],
      }),
      wire(thought),
    ]);
    await expect(collect(recoverThinkingOnlyStream(source, recovery, send))).rejects.toMatchObject({
      code: 'empty_thinking_response',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['data: {"error":{"code":429,"message":"controlled"}}\n\n', 'data: broken-json\n\n'])(
    'does not heal an error after pending STOP: %s',
    async (tail) => {
      const { recovery } = fixture();
      const send = vi.fn();
      const output = collect(
        recoverThinkingOnlyStream(
          Readable.from([wire(thought), Buffer.from(tail)]),
          recovery,
          send,
        ),
      );
      if (tail.includes('broken-json')) {
        await expect(output).rejects.toMatchObject({ code: 'invalid_upstream_response' });
      } else {
        expect(await output).toContain('"code":429');
      }
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: 'SAFETY', candidates: [{ finishReason: 'SAFETY' }] },
    { name: 'MAX_TOKENS', candidates: [{ finishReason: 'MAX_TOKENS' }] },
    { name: 'multiple candidates', candidates: [{ index: 0 }, { index: 1 }] },
  ])('does not heal a conflicting $name tail after pending STOP', async ({ candidates }) => {
    const { recovery } = fixture();
    const send = vi.fn(async () => Readable.from([wire(answer)]));
    const source = Readable.from([wire(thought), wire({ candidates })]);
    await expect(collect(recoverThinkingOnlyStream(source, recovery, send))).rejects.toMatchObject({
      code: 'invalid_upstream_response',
    });
    expect(send).not.toHaveBeenCalled();
  });
});

it('delivers the first continuation answer after an unterminated upstream comment', async () => {
  const { recovery } = fixture();
  const source = Readable.from([wire(thought), ': ping']);
  const send = vi.fn(async () => Readable.from([wire(answer)]));
  const output = await collect(recoverThinkingOnlyStream(source, recovery, send));
  const parser = new IncrementalSseDataParser();
  const candidates = output.split('\n').flatMap((line) => {
    const data = parser.pushLine(line);
    if (data === null) {
      return [];
    }
    const decoded = decodeInternalSseData(data);
    return decoded.kind === 'response' ? (decoded.response.candidates ?? []) : [];
  });
  expect(candidates).toEqual([
    { content: thought.candidates?.[0]?.content },
    answer.candidates?.[0],
  ]);
  expect(send).toHaveBeenCalledOnce();
});

it('destroys an unconsumed source when cancellation preceded wrapper creation', async () => {
  const { recovery } = fixture();
  const controller = new AbortController();
  controller.abort();
  const source = new PassThrough();
  const send = vi.fn();
  await expect(
    collect(recoverThinkingOnlyStream(source, recovery, send, controller.signal)),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(source.destroyed).toBe(true);
  expect(send).not.toHaveBeenCalled();
});

it('uses only the latest usage snapshot of each attempt', async () => {
  const { recovery } = fixture();
  const partial = {
    ...answer,
    candidates: [{ content: { role: 'model', parts: [{ text: 'answer' }] } }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 },
  };
  const send = vi.fn(async () =>
    Readable.from([
      'id: continued\nevent: message\n: progress\n',
      wire(partial),
      wire({ ...answer, candidates: [{ finishReason: 'STOP' }] }),
    ]),
  );
  const output = await collect(
    recoverThinkingOnlyStream(
      Readable.from(['id: initial\nretry: 1000\n', wire(thought)]),
      recovery,
      send,
    ),
  );
  expect(output).toContain('id: initial\nretry: 1000\ndata: ');
  expect(output).toContain('id: continued\nevent: message\n: progress\ndata: ');
  expect(output).toContain('"totalTokenCount":16');
  expect(output).toContain('"totalTokenCount":17');
  expect(output).not.toContain('"totalTokenCount":23');
});

it('normalizes Interactions usage aliases before adding physical attempts', () => {
  expect(
    combineRecoveryUsage(
      {
        total_input_tokens: 7,
        total_output_tokens: 3,
        total_tokens: 10,
        total_cached_tokens: 4,
        total_thought_tokens: 2,
      },
      {
        promptTokenCount: 5,
        candidatesTokenCount: 2,
        totalTokenCount: 7,
        cachedContentTokenCount: 1,
        thoughtsTokenCount: 1,
      },
    ),
  ).toEqual({
    promptTokenCount: 12,
    candidatesTokenCount: 5,
    totalTokenCount: 17,
    cachedContentTokenCount: 5,
    thoughtsTokenCount: 3,
  });
});

it('does not publish first-attempt usage as the combined cost when continuation usage is missing', async () => {
  const { recovery } = fixture();
  const send = vi.fn(async () => Readable.from([wire({ ...answer, usageMetadata: undefined })]));
  const output = await collect(
    recoverThinkingOnlyStream(
      Readable.from([wire({ usageMetadata: thought.usageMetadata }), wire(thought)]),
      recovery,
      send,
    ),
  );
  expect(output).toContain('answer');
  expect(output).not.toContain('usageMetadata');
});

it('preserves wrapped provider details when recovery is enabled', async () => {
  const { recovery } = fixture();
  const error = {
    response: {
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        message: 'controlled',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'RATE_LIMIT_EXCEEDED',
            domain: 'cloudcode-pa.googleapis.com',
          },
        ],
      },
    },
  };
  const send = vi.fn();
  const frame = `id: original-error\r\nevent: error\r\n: upstream\r\ndata:${JSON.stringify(error)}\r\n\r\n`;
  const output = await collect(
    recoverThinkingOnlyStream(Readable.from([frame.slice(0, 19), frame.slice(19)]), recovery, send),
  );
  expect(output).toBe(frame);
  expect(send).not.toHaveBeenCalled();
});

it('forwards unchanged data, framing and EOF metadata in ordinary streams', async () => {
  const { recovery } = fixture();
  const send = vi.fn();
  const source = [
    ': heartbeat\r\n\r\nid: message\r',
    '\nevent: message\r\ndata:{"candidates":\r\n',
    `data: ${JSON.stringify(answer.candidates)}}\r\nretry: 1000\r\n\r\n`,
    ': end without newline',
  ];
  const output = await collect(recoverThinkingOnlyStream(Readable.from(source), recovery, send));
  expect(output).toBe(source.join(''));
  expect(send).not.toHaveBeenCalled();
});

it('retains unknown usage fields as unknown', () => {
  expect(combineRecoveryUsage(undefined, answer.usageMetadata)).toBeUndefined();
  expect(combineRecoveryUsage(thought.usageMetadata, { promptTokenCount: 5 })).toStrictEqual({
    promptTokenCount: 12,
    candidatesTokenCount: undefined,
    totalTokenCount: undefined,
    cachedContentTokenCount: undefined,
    thoughtsTokenCount: undefined,
  });
});

it('cancels a pending continuation and destroys its late source without releasing its reservation early', async () => {
  const { recovery } = fixture();
  let settle!: (value: Readable) => void;
  const pending = new Promise<Readable>((resolve) => {
    settle = resolve;
  });
  const send = vi.fn(() => pending);
  const controller = new AbortController();
  const operation = collect(
    recoverThinkingOnlyStream(Readable.from([wire(thought)]), recovery, send, controller.signal),
  );
  const rejected = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  controller.abort();
  await rejected;
  expect(getStreamOutputRetainedBytes()).toBeGreaterThan(0);
  const late = new PassThrough();
  settle(late);
  await vi.waitFor(() => {
    expect(late.destroyed).toBe(true);
    expect(getStreamOutputRetainedBytes()).toBe(0);
  });
});

it('marks failed recovery causes terminal without replacing their identity', async () => {
  const { recovery } = fixture();
  const error = new Error('controlled provider failure');
  try {
    await expect(
      recovery.invoke(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(isTerminalGenerationFailure(error)).toBe(true);
  } finally {
    recovery.close();
  }
});
