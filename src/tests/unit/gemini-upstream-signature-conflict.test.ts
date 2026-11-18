import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import type { GeminiInternalRequest } from '@/modules/proxy-gateway/antigravity/types';
import { GeminiClient } from '@/server/gateway/modules/gemini/gemini-client.service';
import { Upstream4xxCaptureService } from '@/server/gateway/common/upstream-4xx-capture.service';
import { thoughtStoreService } from '@/modules/proxy-gateway/thought-store/thought-store.service';
import { setServerConfig } from '@/server/server-config';
import {
  runWithTrafficAuditRequestContext,
  type TrafficAuditRequestContext,
} from '@/modules/proxy-gateway/audit/traffic-audit-context';
import { captureGeminiStreamResult } from '@/server/gateway/modules/gemini/gemini-stream-capture';
import { logger } from '@/shared/logging/logger';

const axiosMock = vi.hoisted(() => ({
  post: vi.fn(),
  create: vi.fn(() => ({ get: vi.fn(), post: vi.fn() })),
  isAxiosError: vi.fn(() => false),
}));

vi.mock('axios', () => ({ default: axiosMock, ...axiosMock }));

const request: GeminiInternalRequest = {
  model: 'claude-sonnet-4-6',
  project: 'synthetic-project',
  requestId: 'synthetic-request',
  userAgent: 'synthetic-test',
  request: { contents: [{ role: 'user', parts: [{ text: 'Synthetic request' }] }] },
};
const conflictMessage =
  'Conflicting upstream thoughtSignature and thought_signature at candidates[0].content.parts[0].';

function responseFor(part: object) {
  return { candidates: [{ content: { role: 'model', parts: [part] }, finishReason: 'STOP' }] };
}

function conflictingPart(kind: 'thinking' | 'tool' | 'text') {
  return {
    ...(kind === 'thinking' ? { text: 'reasoning', thought: true } : {}),
    ...(kind === 'text' ? { text: 'answer' } : {}),
    ...(kind === 'tool' ? { functionCall: { id: 'call-1', name: 'read', args: {} } } : {}),
    thoughtSignature: 'synthetic-private-A',
    thought_signature: 'synthetic-private-B',
  };
}

describe('Gemini upstream signature alias conflicts', () => {
  it('commits the full raw reasoning only after a successful upstream end, independently of audit redaction', async () => {
    const context: TrafficAuditRequestContext = {
      attemptSequence: 0,
      parent: null,
      thoughtSessionKey: 'stream-session',
      thoughtSessionStable: true,
    };
    vi.spyOn(thoughtStoreService, 'isEnabled').mockReturnValue(true);
    const capture = vi
      .spyOn(thoughtStoreService, 'captureGeminiResponse')
      .mockImplementation(() => {});
    const first = { thought: true, text: 'first ' };
    const second = { thought: true, text: 'second', thoughtSignature: 'opaque' };
    const tool = {
      functionCall: { id: 'tool', name: 'read', args: { path: '/private-file' } },
      thoughtSignature: 'tool-signature',
    };
    const wire = [
      { candidates: [{ content: { role: 'model', parts: [first] } }] },
      responseFor(second),
      responseFor(tool),
    ].map((value) => `data: ${JSON.stringify(value)}\n\n`);
    const source = Readable.from(wire);
    try {
      await runWithTrafficAuditRequestContext(context, async () => {
        const stream = captureGeminiStreamResult(source, {
          attempt: null,
          model: request.model,
          status: 200,
          outcome: 'completed',
          responseHeaders: {},
          validateSignatures: true,
        });
        let actual = '';
        for await (const chunk of stream) {
          actual += chunk.toString();
        }
        expect(actual).toBe(wire.join(''));
      });
      expect(capture.mock.calls).toEqual([
        [
          'stream-session',
          { candidates: [{ content: { role: 'model', parts: [first, second, tool] } }] },
          request.model,
          context.thoughtCaptureLease,
        ],
      ]);
    } finally {
      context.thoughtCaptureLease?.release();
      source.destroy();
    }
  });

  it('discards a terminal-looking capture when the consumer closes before upstream end', async () => {
    const context: TrafficAuditRequestContext = {
      attemptSequence: 0,
      parent: null,
      thoughtSessionKey: 'stream-session',
      thoughtSessionStable: true,
    };
    vi.spyOn(thoughtStoreService, 'isEnabled').mockReturnValue(true);
    const capture = vi
      .spyOn(thoughtStoreService, 'captureGeminiResponse')
      .mockImplementation(() => {});
    const source = new PassThrough();
    try {
      await runWithTrafficAuditRequestContext(context, async () => {
        const stream = captureGeminiStreamResult(source, {
          attempt: null,
          model: request.model,
          status: 200,
          outcome: 'completed',
          responseHeaders: {},
          validateSignatures: true,
        });
        await new Promise<void>((resolve, reject) => {
          stream.once('error', reject);
          stream.once('data', () => stream.destroy());
          stream.once('close', resolve);
          source.write(
            `data: ${JSON.stringify(responseFor({ text: 'answer', thoughtSignature: 'opaque' }))}\n\n`,
          );
        });
      });
      expect(capture).not.toHaveBeenCalled();
      expect(source.destroyed).toBe(true);
    } finally {
      context.thoughtCaptureLease?.release();
      source.destroy();
    }
  });
  beforeEach(() => {
    axiosMock.post.mockReset();
    axiosMock.isAxiosError.mockReturnValue(false);
    vi.stubEnv('PROXY_INTERNAL_BASE_URLS', '');
    vi.stubEnv('ANTIGRAVITY_INTERNAL_BASE_URLS', '');
    vi.stubEnv('PROXY_CONTEXT_CACHE_ENABLED', 'false');
    setServerConfig(DEFAULT_APP_CONFIG.proxy);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([
    ['waiting_for_output', []],
    ['thinking_only', [{ thought: true, text: 'private stage fixture' }]],
    [
      'output_started',
      [{ thought: true, text: 'private stage fixture' }, { text: 'answer fixture' }],
    ],
    ['output_started', [{ functionCall: { name: 'read', args: { path: 'private fixture' } } }]],
  ] as const)(
    'reports stream deadline progress %s without logging payloads',
    async (stage, parts) => {
      vi.useFakeTimers();
      const source = new PassThrough();
      const warning = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const client = new GeminiClient(new Upstream4xxCaptureService());
      try {
        setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, generation_timeout: 1 });
        axiosMock.post.mockResolvedValue({ status: 200, headers: {}, data: source });
        const stream = await client.streamGenerateInternal(request, 'synthetic-token');
        const error = vi.fn();
        stream.on('error', error);
        stream.resume();
        source.write(
          ': heartbeat\n\ndata: {"response":{"usageMetadata":{"promptTokenCount":5}}}\n\n',
        );
        for (const part of parts) {
          source.write(
            `data: ${JSON.stringify({ response: { candidates: [{ content: { role: 'model', parts: [part] } }] } })}\n\n`,
          );
        }
        await vi.advanceTimersByTimeAsync(1001);
        expect(
          warning.mock.calls.filter(
            ([message]) => message === 'Generation stream deadline exceeded',
          ),
        ).toEqual([['Generation stream deadline exceeded', { phase: stage, requestId: null }]]);
        expect(error).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ name: 'GenerationDeadlineExceededError' }),
        );
        expect(source.destroyed).toBe(true);
      } finally {
        source.destroy();
        await client.onModuleDestroy();
        vi.useRealTimers();
      }
    },
  );

  it.each(['deadline', 'disconnect'] as const)(
    'distinguishes %s while the stream is waiting for response headers',
    async (termination) => {
      vi.useFakeTimers();
      const warning = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const client = new GeminiClient(new Upstream4xxCaptureService());
      const caller = new AbortController();
      try {
        setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, generation_timeout: 1 });
        let dispatched = () => {};
        const started = new Promise<void>((resolve) => {
          dispatched = resolve;
        });
        axiosMock.post.mockImplementation((_url, _body, config: { signal: AbortSignal }) => {
          dispatched();
          return new Promise((_resolve, reject) => {
            config.signal.addEventListener('abort', () => reject(config.signal.reason), {
              once: true,
            });
          });
        });
        const pending = client.streamGenerateInternal(
          request,
          'synthetic-token',
          undefined,
          undefined,
          caller.signal,
        );
        const failure = expect(pending).rejects.toMatchObject({
          name: termination === 'deadline' ? 'GenerationDeadlineExceededError' : 'AbortError',
        });
        await started;
        if (termination === 'disconnect') {
          caller.abort();
        }
        await vi.advanceTimersByTimeAsync(1001);
        await failure;
        expect(
          warning.mock.calls.filter(
            ([message]) => message === 'Generation stream deadline exceeded',
          ),
        ).toEqual(
          termination === 'deadline'
            ? [
                [
                  'Generation stream deadline exceeded',
                  { phase: 'waiting_for_output', requestId: null },
                ],
              ]
            : [],
        );
      } finally {
        caller.abort();
        await client.onModuleDestroy();
        vi.useRealTimers();
      }
    },
  );

  it.each(['thinking', 'tool', 'text'] as const)(
    'rejects an internal %s conflict before capture without endpoint failover',
    async (kind) => {
      const payload = { response: responseFor(conflictingPart(kind)) };
      const before = structuredClone(payload);
      const capture = vi
        .spyOn(thoughtStoreService, 'captureGeminiResponse')
        .mockImplementation(() => {});
      axiosMock.post.mockResolvedValue({ status: 200, headers: {}, data: payload });
      const client = new GeminiClient(new Upstream4xxCaptureService());

      await expect(
        client.generateInternal(request, 'synthetic-token', undefined, undefined, undefined, {
          thoughtReplay: 'skip',
        }),
      ).rejects.toMatchObject({ message: conflictMessage });
      expect(axiosMock.post).toHaveBeenCalledTimes(1);
      expect(capture).not.toHaveBeenCalled();
      expect(payload).toEqual(before);
    },
  );

  it('does not replace an earlier provider error with a later signature conflict in the same chunk', async () => {
    const data = `data: ${JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'controlled first error' } })}\n\ndata: ${JSON.stringify(responseFor(conflictingPart('thinking')))}\n\n`;
    axiosMock.post.mockResolvedValue({
      status: 200,
      headers: {},
      data: Readable.from([Buffer.from(data)]),
    });
    const client = new GeminiClient(new Upstream4xxCaptureService());
    const stream = await client.streamGenerateInternal(
      request,
      'synthetic-token',
      undefined,
      undefined,
      undefined,
      { thoughtReplay: 'skip' },
    );
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString()).toBe(data);
    expect(axiosMock.post).toHaveBeenCalledOnce();
  });

  it('rejects a public unary conflict before capture', async () => {
    const capture = vi
      .spyOn(thoughtStoreService, 'captureGeminiResponse')
      .mockImplementation(() => {});
    axiosMock.post.mockResolvedValue({
      status: 200,
      headers: {},
      data: responseFor(conflictingPart('tool')),
    });
    const client = new GeminiClient(new Upstream4xxCaptureService());
    await expect(
      client.generate(request.model, request.request, 'synthetic-token'),
    ).rejects.toMatchObject({ message: conflictMessage });
    expect(axiosMock.post).toHaveBeenCalledTimes(1);
    expect(capture).not.toHaveBeenCalled();
  });

  it.each([
    { internal: true, terminalDelimiter: true },
    { internal: true, terminalDelimiter: false },
    { internal: false, terminalDelimiter: true },
    { internal: false, terminalDelimiter: false },
  ])(
    'fails a fragmented stream without caching its conflict: $internal/$terminalDelimiter',
    async ({ internal, terminalDelimiter }) => {
      const response = responseFor(conflictingPart('tool'));
      const wire =
        `data: ${JSON.stringify(internal ? { response } : response)}` +
        (terminalDelimiter ? '\n\n' : '');
      const split = wire.indexOf('thought_signature') + 10;
      const source = Readable.from([wire.slice(0, split), wire.slice(split)]);
      axiosMock.post.mockResolvedValue({ status: 200, headers: {}, data: source });
      const capture = vi
        .spyOn(thoughtStoreService, 'captureGeminiResponse')
        .mockImplementation(() => {});
      const client = new GeminiClient(new Upstream4xxCaptureService());
      const stream = internal
        ? await client.streamGenerateInternal(
            request,
            'synthetic-token',
            undefined,
            undefined,
            undefined,
            { thoughtReplay: 'skip' },
          )
        : await client.streamGenerate(request.model, request.request, 'synthetic-token');
      const consume = async () => {
        for await (const chunk of stream) {
          void chunk;
        }
      };

      await expect(consume()).rejects.toMatchObject({ message: conflictMessage });
      expect(axiosMock.post).toHaveBeenCalledTimes(1);
      expect(capture).not.toHaveBeenCalled();
      expect(source.destroyed).toBe(true);
    },
  );

  it('checks original SSE fields even when the audit shadow exhausts its entry budget', async () => {
    const source = Readable.from([
      `data: ${JSON.stringify({
        noise: Array<null>(20_010).fill(null),
        response: responseFor(conflictingPart('thinking')),
      })}\n\n`,
    ]);
    axiosMock.post.mockResolvedValue({ status: 200, headers: {}, data: source });
    const capture = vi
      .spyOn(thoughtStoreService, 'captureGeminiResponse')
      .mockImplementation(() => {});
    const client = new GeminiClient(new Upstream4xxCaptureService());
    const stream = await client.streamGenerateInternal(
      request,
      'synthetic-token',
      undefined,
      undefined,
      undefined,
      { thoughtReplay: 'skip' },
    );
    const consume = async () => {
      for await (const chunk of stream) {
        void chunk;
      }
    };
    await expect(consume()).rejects.toMatchObject({ message: conflictMessage });
    expect(capture).not.toHaveBeenCalled();
    expect(source.destroyed).toBe(true);
  });

  it('withholds a complete conflicting data line until its separately delivered event boundary', async () => {
    const line = `data: ${JSON.stringify({ response: responseFor(conflictingPart('tool')) })}\n`;
    const source = new PassThrough();
    axiosMock.post.mockResolvedValue({ status: 200, headers: {}, data: source });
    const client = new GeminiClient(new Upstream4xxCaptureService());
    const stream = await client.streamGenerateInternal(
      request,
      'synthetic-token',
      undefined,
      undefined,
      undefined,
      { thoughtReplay: 'skip' },
    );
    const delivered: string[] = [];
    stream.on('data', (chunk: Buffer | string) =>
      delivered.push(Buffer.from(chunk).toString('utf8')),
    );
    const consume = async () => {
      for await (const chunk of stream) {
        void chunk;
      }
    };
    const completion = consume();
    source.write(line);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const beforeBoundary = [...delivered];
    source.end('\n');
    await expect(completion).rejects.toMatchObject({ message: conflictMessage });
    expect(beforeBoundary).toEqual([]);
    expect(delivered).toEqual([]);
    expect(source.destroyed).toBe(true);
  });

  it.each(['unary', 'stream'] as const)(
    'preserves equivalent aliases and original response values on %s transport',
    async (mode) => {
      const raw = Buffer.from([0x08, 0x04, 0x12, ...Array<number>(80).fill(0x7f)]).toString(
        'base64',
      );
      const wrapped = Buffer.from(raw, 'utf8').toString('base64');
      const payload = {
        response: responseFor({
          text: 'answer',
          thoughtSignature: raw,
          thought_signature: wrapped,
        }),
      };
      const before = structuredClone(payload);
      const wire = `data: ${JSON.stringify(payload)}\n\n`;
      axiosMock.post.mockResolvedValue({
        status: 200,
        headers: {},
        data: mode === 'stream' ? Readable.from([wire]) : payload,
      });
      const client = new GeminiClient(new Upstream4xxCaptureService());
      if (mode === 'unary') {
        await expect(
          client.generateInternal(request, 'synthetic-token', undefined, undefined, undefined, {
            thoughtReplay: 'skip',
          }),
        ).resolves.toEqual(payload.response);
      } else {
        const stream = await client.streamGenerateInternal(
          request,
          'synthetic-token',
          undefined,
          undefined,
          undefined,
          { thoughtReplay: 'skip' },
        );
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          chunks.push(Buffer.from(chunk));
        }
        expect(Buffer.concat(chunks).toString('utf8')).toBe(wire);
      }
      expect(payload).toEqual(before);
      expect(axiosMock.post).toHaveBeenCalledTimes(1);
    },
  );
});
