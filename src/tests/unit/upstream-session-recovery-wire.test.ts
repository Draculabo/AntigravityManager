import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import {
  GeminiClient,
  type InternalGenerationOptions,
} from '@/server/gateway/modules/gemini/gemini-client.service';
import { Upstream4xxCaptureService } from '@/server/gateway/common/upstream-4xx-capture.service';
import { createUpstreamSessionIdentity } from '@/server/gateway/common/upstream-session-identity';
import type { GeminiInternalRequest } from '@/modules/proxy-gateway/antigravity/types';
import { explicitContextCacheManager } from '@/server/gateway/modules/gemini/explicit-context-cache.store';
import { thoughtStoreService } from '@/modules/proxy-gateway/thought-store/thought-store.service';
import * as audit from '@/modules/proxy-gateway/audit/traffic-audit-context';

const axiosMock = vi.hoisted(() => ({
  post: vi.fn(),
  create: vi.fn(() => ({ get: vi.fn(), post: vi.fn() })),
  isAxiosError: vi.fn(),
}));
vi.mock('axios', () => ({ default: axiosMock, ...axiosMock }));
const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
const identity = createUpstreamSessionIdentity('synthetic-account', 'synthetic-store');
const wireSchema = z
  .object({
    model: z.string(),
    project: z.string(),
    requestId: z.string(),
    request: z
      .object({
        sessionId: z.string(),
        contents: z.array(z.unknown()),
        cachedContent: z.string().optional(),
        systemInstruction: z.unknown().optional(),
      })
      .passthrough(),
  })
  .passthrough();
const body: GeminiInternalRequest = {
  model: 'claude-sonnet-4-6',
  project: 'synthetic-project',
  requestId: 'original',
  userAgent: 'test',
  request: { contents: [{ role: 'user', parts: [{ text: 'Synthetic full input' }] }] },
};
const inputLimit = 'The input token count exceeds the maximum number of tokens allowed 1048576';
function failure(status = 400, message = inputLimit) {
  return { message, response: { status, headers: {}, data: { error: { message } } } };
}
async function wires() {
  return Promise.all(
    axiosMock.post.mock.calls.map(async ([, value]) => {
      let text = '';
      if (typeof value === 'string') {
        text = value;
      } else if (value instanceof Readable) {
        for await (const chunk of value) {
          if (typeof chunk === 'string') {
            text += chunk;
          } else if (Buffer.isBuffer(chunk)) {
            text += chunk.toString('utf8');
          } else {
            throw new Error('Unexpected serialized fixture chunk');
          }
        }
      } else {
        throw new Error('Expected a bounded serialized fixture');
      }
      return wireSchema.parse(JSON.parse(text));
    }),
  );
}
function fixture() {
  const capture = new Upstream4xxCaptureService();
  const saved = vi.spyOn(capture, 'capture').mockResolvedValue();
  const client = new GeminiClient(capture);
  const options: InternalGenerationOptions = {
    recoveryAccountId: 'synthetic-account',
    upstreamSession: identity,
    canRecoverUpstreamSession: () => true,
    recoveryBudget: { attempted: false },
  };
  const execute = (stream = false, signal?: AbortSignal) =>
    stream
      ? client.streamGenerateInternal(
          structuredClone(body),
          'synthetic-token',
          undefined,
          undefined,
          signal,
          options,
        )
      : client.generateInternal(
          structuredClone(body),
          'synthetic-token',
          undefined,
          undefined,
          signal,
          options,
        );
  return { client, options, saved, execute };
}
beforeEach(() => {
  axiosMock.post.mockReset();
  axiosMock.post.mockResolvedValue({ status: 200, headers: {}, data: { candidates: [] } });
  axiosMock.isAxiosError.mockImplementation(
    (value: unknown) => typeof value === 'object' && value !== null && 'response' in value,
  );
  vi.stubEnv('PROXY_INTERNAL_BASE_URLS', '');
  vi.stubEnv('ANTIGRAVITY_INTERNAL_BASE_URLS', '');
  vi.stubEnv('PROXY_CONTEXT_CACHE_ENABLED', 'false');
  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, generation_timeout: 1 });
  vi.spyOn(thoughtStoreService, 'prepareInternalRequest').mockResolvedValue();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setServerConfig(previous);
});

describe('bounded upstream context recovery at the physical send boundary', () => {
  it('drops a deleted account generation at the next actual send', async () => {
    const { client, execute } = fixture();
    axiosMock.post.mockRejectedValueOnce(failure());
    await execute();
    client.forgetDeletedAccount('unrelated-account');
    await execute();
    client.forgetDeletedAccount('synthetic-account');
    await execute();
    const sent = await wires();
    expect(sent.map((value) => value.request.sessionId)).toEqual([
      identity.sessionId,
      sent[1].request.sessionId,
      sent[1].request.sessionId,
      identity.sessionId,
    ]);
    expect(sent[1].request.sessionId).not.toBe(identity.sessionId);
    expect(sent.every((value) => value.requestId.split('/')[1] === identity.conversationId)).toBe(
      true,
    );
  });

  it.each([false, true])(
    'resends once with the same input/credential/model and a new scoped identity, stream=%s',
    async (stream) => {
      const { execute, options, saved } = fixture();
      const attempts = vi.spyOn(audit, 'startCurrentUpstreamAttempt');
      axiosMock.post.mockRejectedValueOnce(
        stream
          ? {
              message: 'Request failed with status code 400',
              response: {
                status: 400,
                headers: {},
                data: Readable.from([JSON.stringify({ error: { message: inputLimit } })]),
              },
            }
          : failure(),
      );
      const source = Readable.from([]);
      if (stream) {
        axiosMock.post.mockResolvedValue({ status: 200, headers: {}, data: source });
      }
      try {
        await execute(stream);
        const sent = await wires();
        expect(sent).toHaveLength(2);
        expect(sent[0].request.sessionId).toBe(identity.sessionId);
        expect(sent[1].request.sessionId).not.toBe(identity.sessionId);
        expect(sent.map((value) => value.requestId.split('/')[1])).toEqual([
          identity.conversationId,
          identity.conversationId,
        ]);
        expect(sent[0].requestId).not.toBe(sent[1].requestId);
        expect(
          sent.map((value) => ({
            model: value.model,
            project: value.project,
            contents: value.request.contents,
          })),
        ).toEqual(
          [0, 1].map(() => ({
            model: body.model,
            project: body.project,
            contents: body.request.contents,
          })),
        );
        expect(
          axiosMock.post.mock.calls.map(([url, , config]) => ({
            url,
            authorization: config.headers.Authorization,
          })),
        ).toEqual(
          [0, 1].map(() => ({
            url: axiosMock.post.mock.calls[0][0],
            authorization: 'Bearer synthetic-token',
          })),
        );
        expect(attempts.mock.calls.map(([input]) => input.requestBody)).toEqual(sent);
        expect(saved.mock.calls.map(([input]) => input.upstreamRequest)).toEqual([sent[0]]);
        expect(options.recoveryBudget?.attempted).toBe(true);
      } finally {
        source.destroy();
      }
    },
  );

  it.each([400, 429])(
    'reports recovery failure without additional endpoint sends, status=%s',
    async (status) => {
      const { execute, saved } = fixture();
      axiosMock.post
        .mockRejectedValueOnce(failure())
        .mockRejectedValue(failure(status, 'Recovery still failed'));
      let final: unknown;
      try {
        await execute();
      } catch (error) {
        final = error;
      }
      expect(final).toMatchObject({
        status,
        message: 'Recovery still failed',
        cause: { status: 400, message: inputLimit },
      });
      expect(axiosMock.post).toHaveBeenCalledTimes(2);
      expect(saved.mock.calls.map(([input]) => input.upstreamRequest)).toEqual(await wires());
    },
  );

  it.each(['Invalid thought signature', 'Output token count exceeds the maximum number of tokens'])(
    'does not recover unrelated 400: %s',
    async (message) => {
      const { execute } = fixture();
      axiosMock.post.mockRejectedValue(failure(400, message));
      await expect(execute()).rejects.toMatchObject({ status: 400, message });
      expect(axiosMock.post).toHaveBeenCalledOnce();
    },
  );

  it('stops before a resend when the lease becomes ineligible at final admission', async () => {
    const { execute, options } = fixture();
    options.canRecoverUpstreamSession = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    axiosMock.post.mockRejectedValueOnce(failure());
    await expect(execute()).rejects.toMatchObject({ status: 400 });
    expect(axiosMock.post).toHaveBeenCalledOnce();
    expect(options.recoveryBudget?.attempted).toBe(false);
  });

  it.each(['cancel', 'deadline'] as const)('does not recover after %s', async (mode) => {
    const { execute, options } = fixture();
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const abort = new AbortController();
    axiosMock.post.mockImplementationOnce(async () => {
      if (mode === 'cancel') {
        abort.abort();
      } else {
        now = 1001;
      }
      throw failure();
    });
    await expect(execute(false, abort.signal)).rejects.toBeInstanceOf(Error);
    expect(axiosMock.post).toHaveBeenCalledOnce();
    expect(options.recoveryBudget?.attempted).toBe(false);
  });

  it('spends only the remaining initial-call budget including thought preparation', async () => {
    const { execute } = fixture();
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.mocked(thoughtStoreService.prepareInternalRequest).mockImplementationOnce(async () => {
      now = 400;
    });
    axiosMock.post.mockRejectedValueOnce(failure());
    await execute();
    expect(axiosMock.post.mock.calls[1][2].timeout).toBe(600);
  });

  it('retains complete thought-prepared input when the initial cached prefix overflows', async () => {
    const { execute } = fixture();
    vi.stubEnv('PROXY_CONTEXT_CACHE_ENABLED', 'true');
    vi.spyOn(explicitContextCacheManager, 'resolve').mockResolvedValue('cachedContents/synthetic');
    const instruction = { parts: [{ text: 'S'.repeat(9000) }] };
    vi.mocked(thoughtStoreService.prepareInternalRequest).mockImplementationOnce(
      async (prepared) => {
        prepared.request.systemInstruction = instruction;
      },
    );
    axiosMock.post.mockRejectedValueOnce(failure());
    await execute();
    const sent = await wires();
    expect(sent[0].request.cachedContent).toBe('cachedContents/synthetic');
    expect(sent[0].request.systemInstruction).toBeUndefined();
    expect(sent[1].request.cachedContent).toBeUndefined();
    expect(sent[1].request.systemInstruction).toEqual(instruction);
    expect(body.request.systemInstruction).toBeUndefined();
  });

  it('does not reset the logical send budget across a later account/client fallback', async () => {
    const { execute } = fixture();
    axiosMock.post.mockRejectedValueOnce(failure()).mockRejectedValue(failure());
    await expect(execute()).rejects.toMatchObject({ status: 400 });
    await expect(execute()).rejects.toMatchObject({ status: 400 });
    expect(axiosMock.post).toHaveBeenCalledTimes(3);
  });

  it('never starts context recovery after returning a response stream', async () => {
    const { execute, options } = fixture();
    const source = Readable.from([
      `data: ${JSON.stringify({ error: { message: inputLimit, code: 400 } })}\n\n`,
    ]);
    axiosMock.post.mockResolvedValue({ status: 200, headers: {}, data: source });
    try {
      const response = await execute(true);
      if (!(response instanceof Readable)) {
        throw new Error('Expected the provider stream');
      }
      let output = '';
      for await (const chunk of response) {
        output += chunk.toString();
      }
      expect(output).toContain(inputLimit);
      expect(axiosMock.post).toHaveBeenCalledOnce();
      expect(options.recoveryBudget?.attempted).toBe(false);
    } finally {
      source.destroy();
    }
  });
});
