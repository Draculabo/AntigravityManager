import { Readable } from 'node:stream';
import axios, { AxiosError, AxiosHeaders } from 'axios';
import { Logger } from '@nestjs/common';
import { Observable } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiClient } from '@/server/gateway/modules/gemini/gemini-client.service';
import {
  getStreamOutputRetainedBytes,
  StreamOutputBudget,
} from '@/server/gateway/common/stream-output-budget';
import { thoughtStoreService } from '@/modules/proxy-gateway/thought-store/thought-store.service';
import type { GeminiInternalRequest } from '@/modules/proxy-gateway/antigravity/types';
import { runWithTrafficAuditRequestContext } from '@/modules/proxy-gateway/audit/traffic-audit-context';
import { trafficAuditService } from '@/modules/proxy-gateway/audit/traffic-audit.service';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
} from './proxy-real-path.harness';

const state = vi.hoisted((): { enabled: boolean | undefined } => ({ enabled: true }));
vi.mock('@/server/server-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/server-config')>();
  const { DEFAULT_APP_CONFIG: DEFAULT_CONFIG } = await import('@/modules/config/types');
  return {
    ...actual,
    getServerConfig: () => ({
      ...DEFAULT_CONFIG.proxy,
      request_timeout: 10,
      experimental: { ...DEFAULT_CONFIG.proxy.experimental, thinking_only_recovery: state.enabled },
    }),
  };
});
vi.mock('@/server/gateway/common/utils/request-user-agent', () => ({
  resolveRequestUserAgent: async () => 'controlled-thinking-recovery/0.0.0',
  buildContentRequestUserAgent: () => 'controlled-thinking-recovery/0.0.0',
  resolveLocalInstalledVersion: () => '0.0.0',
}));

type Protocol = 'chat' | 'responses' | 'messages' | 'gemini';
const thought = {
  candidates: [
    {
      content: { role: 'model', parts: [{ thought: true, text: 'controlled reasoning' }] },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
};
const answer = {
  candidates: [
    {
      content: { role: 'model', parts: [{ text: 'controlled final answer' }] },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
};

async function run(
  protocol: Protocol,
  stream: boolean,
  second: 'answer' | 'empty' | 'http-error' = 'answer',
) {
  const sent: unknown[] = [];
  const post = vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
    const chunks: Buffer[] = [];
    if (body instanceof Readable) {
      for await (const chunk of body) {
        chunks.push(Buffer.from(chunk));
      }
      sent.push(JSON.parse(Buffer.concat(chunks).toString()));
    } else {
      sent.push(typeof body === 'string' ? JSON.parse(body) : body);
    }
    if (sent.length === 2 && second === 'http-error') {
      const error = new AxiosError('controlled continuation rejection');
      error.response = {
        status: 503,
        statusText: '',
        data: { error: { message: 'controlled continuation rejection' } },
        headers: new AxiosHeaders(),
        config: { headers: new AxiosHeaders() },
      };
      throw error;
    }
    const response = sent.length === 1 || second === 'empty' ? thought : answer;
    return {
      status: 200,
      headers: new AxiosHeaders(),
      config: { headers: new AxiosHeaders() },
      data: stream
        ? Readable.from([Buffer.from(`data: ${JSON.stringify({ response })}\n\n`)])
        : { response },
    };
  });
  const client = new GeminiClient({ capture: vi.fn() } as never);
  const upstream = createUpstream({});
  upstream.generateInternal.mockImplementation((...args) => client.generateInternal(...args));
  upstream.streamGenerateInternal.mockImplementation(async (...args) => {
    const source = await client.streamGenerateInternal(...args);
    if (!(source instanceof Readable)) {
      throw new Error('Expected captured Readable');
    }
    return source;
  });
  const lease = createLease([createAccount('thinking-recovery-controlled')]);
  const gateway = createGateway(upstream, lease);
  const execute = async () => {
    let result;
    if (protocol === 'gemini') {
      const request = { contents: [{ role: 'user', parts: [{ text: 'controlled request' }] }] };
      result = stream
        ? await gateway.geminiService.handleGeminiStreamGenerateContent('gemini-3-flash', request)
        : await gateway.geminiService.handleGeminiGenerateContent('gemini-3-flash', request);
    } else if (protocol === 'messages') {
      result = await gateway.anthropicService.handleAnthropicMessages({
        model: 'claude-sonnet-4-5',
        max_tokens: 32,
        stream,
        messages: [{ role: 'user', content: 'controlled request' }],
      });
    } else {
      result = await gateway.openAIService.handleChatCompletions(
        {
          model: 'gemini-3-flash',
          stream,
          stream_options: { include_usage: true },
          messages: [{ role: 'user', content: 'controlled request' }],
        },
        protocol === 'responses' ? 'responses' : 'chat-completions',
      );
    }
    if (result instanceof Observable) {
      const chunks: string[] = [];
      await new Promise<void>((resolve, reject) =>
        result.subscribe({
          next: (chunk: string) => chunks.push(chunk),
          error: reject,
          complete: resolve,
        }),
      );
      return chunks.join('');
    }
    return JSON.stringify(result);
  };
  return { sent, post, lease, execute };
}

beforeEach(() => {
  state.enabled = true;
  vi.stubEnv(
    'PROXY_INTERNAL_BASE_URLS',
    'https://controlled-thinking.invalid/v1internal,https://unused-thinking.invalid/v1internal',
  );
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  vi.spyOn(thoughtStoreService, 'prepareInternalRequest').mockResolvedValue(undefined);
  vi.spyOn(thoughtStoreService, 'captureGeminiResponse').mockImplementation(() => undefined);
  vi.spyOn(thoughtStoreService, 'captureGeminiResponse').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  expect(getStreamOutputRetainedBytes()).toBe(0);
});

it('recovers a clean thinking-only reply when the profile has no explicit override', async () => {
  state.enabled = undefined;
  const { execute, sent } = await run('chat', true);
  expect(await execute()).toContain('controlled final answer');
  expect(sent).toHaveLength(2);
});

it('still sends a valid initial request when optional recovery cannot retain its snapshot', async () => {
  const { execute, post } = await run('chat', false);
  post.mockResolvedValue({
    status: 200,
    headers: new AxiosHeaders(),
    config: { headers: new AxiosHeaders() },
    data: { response: answer },
  });
  const occupied = new StreamOutputBudget(256 * 1024 * 1024);
  expect(occupied.reserve(256 * 1024 * 1024)).toBe(true);
  try {
    expect(await execute()).toContain('controlled final answer');
    expect(post).toHaveBeenCalledOnce();
  } finally {
    occupied.clear();
  }
});

it('preserves signature wire encoding on continuation without replaying new thought', async () => {
  const raw = Buffer.from([0x08, 0x04, 0x12, ...Array<number>(80).fill(0x7f)]).toString('base64');
  const wrapped = Buffer.from(raw).toString('base64');
  const body: GeminiInternalRequest = {
    model: 'claude-sonnet-4-6',
    requestId: 'controlled-child',
    userAgent: 'controlled/0.0.0',
    request: {
      contents: [
        { role: 'user', parts: [{ text: 'controlled initial request' }] },
        {
          role: 'model',
          parts: [{ thought: true, text: 'prior reasoning', thoughtSignature: raw }],
        },
        { role: 'user', parts: [{ text: 'Continue.' }] },
      ],
    },
  };
  const before = structuredClone(body);
  const replay = vi.spyOn(thoughtStoreService, 'prepareInternalRequest');
  const post = vi.spyOn(axios, 'post').mockImplementation(async (_url, wireBody) => {
    const chunks: Buffer[] = [];
    let sent: unknown = typeof wireBody === 'string' ? JSON.parse(wireBody) : wireBody;
    if (wireBody instanceof Readable) {
      for await (const chunk of wireBody) {
        chunks.push(Buffer.from(chunk));
      }
      sent = JSON.parse(Buffer.concat(chunks).toString());
    }
    expect(sent).toMatchObject({
      requestId: 'controlled-child',
      request: {
        contents: [
          { role: 'user', parts: [{ text: 'controlled initial request' }] },
          { role: 'model', parts: [{ thoughtSignature: wrapped }] },
          { role: 'user', parts: [{ text: 'Continue.' }] },
        ],
      },
    });
    return {
      status: 200,
      headers: new AxiosHeaders(),
      config: { headers: new AxiosHeaders() },
      data: { response: answer },
    };
  });
  const client = new GeminiClient({ capture: vi.fn() } as never);
  await client.generateInternal(body, 'synthetic-token', undefined, undefined, undefined, {
    thinkingRecovery: {
      timeoutMs: 1000,
      transport: {
        baseUrl: 'https://controlled.invalid/v1internal',
        proxy: false,
        headers: { Authorization: 'Bearer synthetic-token' },
      },
    },
  });
  expect(post).toHaveBeenCalledOnce();
  expect(replay).not.toHaveBeenCalled();
  expect(body).toEqual(before);
});

it.each([false, true])(
  'records two physical attempts with distinct generation outcomes (stream=%s)',
  async (stream) => {
    const start = vi.spyOn(trafficAuditService, 'startAttempt').mockReturnValue(null);
    const complete = vi
      .spyOn(trafficAuditService, 'completeAttempt')
      .mockImplementation(() => undefined);
    const context = {
      attemptSequence: 0,
      parent: null,
      thoughtSessionKey: 'controlled-audit-session',
      thoughtSessionStable: true,
    };
    const { execute } = await run('gemini', stream);
    await runWithTrafficAuditRequestContext(context, execute);
    expect(context.attemptSequence).toBe(2);
    expect(
      start.mock.calls.map(([, index, input]) => ({
        index,
        accountId: input.accountId,
        operation: input.operation,
      })),
    ).toEqual([
      {
        index: 1,
        accountId: 'thinking-recovery-controlled',
        operation: stream ? 'stream-generate' : 'generate-content',
      },
      {
        index: 2,
        accountId: 'thinking-recovery-controlled',
        operation: stream ? 'stream-generate' : 'generate-content',
      },
    ]);
    expect(
      complete.mock.calls.map(([, result]) => ({
        outcome: result.outcome,
        status: result.status,
        message: result.error instanceof Error ? result.error.message : result.error,
      })),
    ).toEqual([
      {
        outcome: 'upstream_error',
        status: 200,
        message: 'Upstream returned empty thinking-only response',
      },
      { outcome: 'completed', status: 200, message: undefined },
    ]);
  },
);

describe.each(['chat', 'responses', 'messages', 'gemini'] as const)(
  '%s thinking-only continuation',
  (protocol) => {
    it.each([false, true])(
      'performs one same-transport continuation and reports real output (stream=%s)',
      async (stream) => {
        const { execute, sent, post, lease } = await run(protocol, stream);
        const output = await execute();
        expect(output).toContain('controlled final answer');
        expect(output).not.toContain('task ready');
        expect(post).toHaveBeenCalledTimes(2);
        expect(post.mock.calls[0][0]).toBe(post.mock.calls[1][0]);
        expect(post.mock.calls[0][2]?.headers).toEqual(post.mock.calls[1][2]?.headers);
        expect(post.mock.calls[0][2]?.proxy).toEqual(post.mock.calls[1][2]?.proxy);
        expect(sent[1]).toMatchObject({
          model: expect.any(String),
          requestId: expect.any(String),
          request: {
            contents: [
              { role: 'user', parts: [{ text: 'controlled request' }, { text: 'Continue.' }] },
            ],
          },
        });
        const ids = sent.map((value) =>
          typeof value === 'object' && value !== null && 'requestId' in value
            ? value.requestId
            : undefined,
        );
        expect(ids[0]).toBeDefined();
        expect(ids[1]).not.toBe(ids[0]);
        expect(lease.markModelSuccess).toHaveBeenCalledOnce();
        if (protocol === 'gemini') {
          expect(output).toContain('"totalTokenCount":17');
        }
        if (protocol === 'responses') {
          expect(output).toContain('"total_tokens":17');
        }
      },
    );

    it.each([false, true])('does not continue by default (stream=%s)', async (stream) => {
      state.enabled = false;
      const { execute, post, lease } = await run(protocol, stream);
      if (stream) {
        expect(await execute()).toContain('"error":');
      } else {
        await expect(execute()).rejects.toMatchObject({ code: 'empty_thinking_response' });
      }
      expect(post).toHaveBeenCalledOnce();
      expect(lease.markModelSuccess).not.toHaveBeenCalled();
    });

    it.each([false, true])(
      'terminates a failed continuation without another endpoint/account/generation (stream=%s)',
      async (stream) => {
        const { execute, post, lease } = await run(protocol, stream, 'http-error');
        if (stream) {
          const output = await execute();
          expect(output).toContain('"error":');
          expect(output).not.toContain('event: response.completed');
          expect(output).not.toContain('event: message_stop');
          expect(output).not.toContain('data: [DONE]');
        } else {
          await expect(execute()).rejects.toMatchObject({ status: 503 });
        }
        expect(post).toHaveBeenCalledTimes(2);
        expect(lease.markModelSuccess).not.toHaveBeenCalled();
      },
    );

    it.each([false, true])(
      'never starts a second continuation for another empty answer (stream=%s)',
      async (stream) => {
        const { execute, post, lease } = await run(protocol, stream, 'empty');
        if (stream) {
          expect(await execute()).toContain('"error":');
        } else {
          await expect(execute()).rejects.toMatchObject({ code: 'empty_thinking_response' });
        }
        expect(post).toHaveBeenCalledTimes(2);
        expect(lease.markModelSuccess).not.toHaveBeenCalled();
      },
    );
  },
);
