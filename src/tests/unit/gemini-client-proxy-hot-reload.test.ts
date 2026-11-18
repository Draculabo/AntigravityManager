import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough, Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { logger as diagnosticLogger } from '@/shared/logging/logger';

import { DEFAULT_APP_CONFIG, type ProxyConfig } from '@/modules/config/types';
import { setServerConfig } from '@/server/server-config';
import { GeminiClient } from '@/server/gateway/modules/gemini/gemini-client.service';
import { Upstream4xxCaptureService } from '@/server/gateway/common/upstream-4xx-capture.service';
import { UpstreamProxyConfigurationError } from '@/modules/config/upstream-proxy.schema';
import type { GeminiInternalRequest } from '@/modules/proxy-gateway/antigravity/types';
import { thoughtStoreService } from '@/modules/proxy-gateway/thought-store/thought-store.service';
import { explicitContextCacheManager } from '@/server/gateway/modules/gemini/explicit-context-cache.store';
import { estimateRequestContext } from '@/server/gateway/common/request-context-estimate';
import { errorProcessOwner } from '@/modules/error-diagnostics/public';

const axiosMock = vi.hoisted(() => ({
  post: vi.fn(),
  create: vi.fn(() => ({
    get: vi.fn(),
    post: vi.fn(),
  })),
  isAxiosError: vi.fn(() => false),
}));

vi.mock('axios', () => ({
  default: axiosMock,
  create: axiosMock.create,
  post: axiosMock.post,
  isAxiosError: axiosMock.isAxiosError,
}));

function createProxyConfig(url: string): ProxyConfig {
  return {
    ...DEFAULT_APP_CONFIG.proxy,
    upstream_proxy: {
      enabled: true,
      url,
    },
  };
}

describe('GeminiClient upstream proxy config', () => {
  beforeEach(() => {
    axiosMock.post.mockReset();
    axiosMock.isAxiosError.mockReturnValue(false);
    axiosMock.post.mockResolvedValue({ data: { candidates: [] } });
  });

  it('reads upstream proxy config on each request so runtime changes take effect', async () => {
    const client = new GeminiClient(new Upstream4xxCaptureService());

    setServerConfig(createProxyConfig('http://user:pass@127.0.0.1:8080'));
    await client.generate('gemini-3-flash', { contents: [] } as never, 'access-token');

    setServerConfig(createProxyConfig('http://127.0.0.1:9090'));
    await client.generate('gemini-3-flash', { contents: [] } as never, 'access-token');

    expect(axiosMock.post.mock.calls.map(([, , options]) => options.proxy)).toEqual([false, false]);
    expect(
      axiosMock.post.mock.calls.map(([, , options]) => options.httpsAgent?.proxy.href),
    ).toEqual(['http://127.0.0.1:8080/', 'http://127.0.0.1:9090/']);
  });

  it('keeps the proxy snapshot across endpoint retries and refreshes it for the next request', async () => {
    const client = new GeminiClient(new Upstream4xxCaptureService());
    const internalBody: GeminiInternalRequest = {
      model: 'gemini-3-flash',
      project: 'synthetic-project',
      requestId: 'synthetic-request',
      userAgent: 'synthetic-test',
      request: { contents: [{ role: 'user', parts: [{ text: 'controlled proxy request' }] }] },
    };
    const firstProxy = createProxyConfig('http://127.0.0.1:8080');
    const updatedProxy = createProxyConfig('http://127.0.0.1:9090');
    setServerConfig(firstProxy);
    axiosMock.isAxiosError.mockReturnValue(true);
    axiosMock.post.mockImplementation(async () => {
      const requestNumber = axiosMock.post.mock.calls.length;
      if (requestNumber === 1) {
        setServerConfig(updatedProxy);
        return Promise.reject({
          response: { status: 503, headers: {}, data: { error: { status: 'UNAVAILABLE' } } },
        });
      }
      return { status: 200, headers: {}, data: { candidates: [] } };
    });

    await expect(client.generateInternal(internalBody, 'synthetic-token')).resolves.toEqual({
      candidates: [],
    });
    await client.countTokensInternal(
      {
        request: {
          model: `models/${internalBody.model}`,
          contents: internalBody.request.contents,
        },
      },
      'synthetic-token',
    );

    expect(
      axiosMock.post.mock.calls.map(([, , options]) => options.httpsAgent?.proxy.port),
    ).toEqual(['8080', '8080', '9090']);
  });

  it('does not fail over to another endpoint when cancellation arrives during a request', async () => {
    const client = new GeminiClient(new Upstream4xxCaptureService());
    const controller = new AbortController();
    axiosMock.isAxiosError.mockReturnValue(true);
    axiosMock.post.mockImplementation(async (_url, _body, options) => {
      controller.abort();
      return Promise.reject({
        response: { status: 503, headers: {}, data: { error: { status: 'UNAVAILABLE' } } },
        config: { signal: options?.signal },
      });
    });

    await expect(
      client.generateInternal(
        {
          model: 'gemini-3-flash',
          project: 'synthetic-project',
          requestId: 'synthetic-request',
          userAgent: 'synthetic-test',
          request: { contents: [{ role: 'user', parts: [{ text: 'controlled cancellation' }] }] },
        },
        'synthetic-token',
        undefined,
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow('cancelled');

    expect(axiosMock.post).toHaveBeenCalledOnce();
  });

  it.each([
    'not-a-url',
    'socks5://127.0.0.1:1080',
    'http://127.0.0.1:not-a-port',
    'http://127.0.0.1:99999',
  ])('fails the request instead of silently dropping the proxy: %s', async (url) => {
    const client = new GeminiClient(new Upstream4xxCaptureService());

    setServerConfig(createProxyConfig(url));
    await expect(
      client.generate('gemini-3-flash', { contents: [] } as never, 'access-token'),
    ).rejects.toThrow(UpstreamProxyConfigurationError);

    expect(axiosMock.post).not.toHaveBeenCalled();
  });
});

describe('GeminiClient internal endpoint selection', () => {
  it('captures the original failed-send Error once when another endpoint recovers without HTTP audit context', async () => {
    vi.stubEnv(
      'PROXY_INTERNAL_BASE_URLS',
      'https://one.invalid/v1internal,https://two.invalid/v1internal',
    );
    const capture = vi.spyOn(errorProcessOwner, 'capture');
    const error = Object.assign(
      new Error('controlled connection reset', { cause: new Error('socket source') }),
      { code: 'ECONNRESET' },
    );
    axiosMock.post
      .mockRejectedValueOnce(error)
      .mockResolvedValue({ status: 200, headers: {}, data: { totalTokens: 12 } });
    try {
      const client = new GeminiClient(new Upstream4xxCaptureService());
      await expect(
        client.countTokensInternal(
          {
            request: {
              model: 'models/gemini-3-flash',
              contents: [{ role: 'user', parts: [{ text: 'controlled' }] }],
            },
          },
          'synthetic-token',
        ),
      ).resolves.toEqual({ totalTokens: 12 });
      expect(axiosMock.post).toHaveBeenCalledTimes(2);
      expect(capture.mock.calls.filter(([input]) => input.stage === 'upstream-attempt')).toEqual([
        [
          expect.objectContaining({
            error,
            category: 'transfer',
            functionName: 'count-tokens',
            requestId: undefined,
            attemptId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
          }),
        ],
      ]);
    } finally {
      capture.mockRestore();
    }
  });
  it('forwards the count cancellation signal to Axios and refuses an aborted count before transport', async () => {
    const client = new GeminiClient(new Upstream4xxCaptureService());
    const controller = new AbortController();
    const input = {
      request: {
        model: 'models/gemini-3-flash',
        contents: [{ role: 'user', parts: [{ text: 'controlled count' }] }],
      },
    };
    axiosMock.post.mockResolvedValue({ status: 200, headers: {}, data: { totalTokens: 12 } });
    await expect(
      client.countTokensInternal(input, 'synthetic-token', undefined, undefined, controller.signal),
    ).resolves.toEqual({ totalTokens: 12 });
    const forwarded: unknown = axiosMock.post.mock.calls[0]?.[2]?.signal;
    expect(forwarded).toBeInstanceOf(AbortSignal);
    controller.abort();
    expect(forwarded).toMatchObject({ aborted: true });
    const calls = axiosMock.post.mock.calls.length;
    await expect(
      client.countTokensInternal(input, 'synthetic-token', undefined, undefined, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(axiosMock.post).toHaveBeenCalledTimes(calls);
  });
  const body: GeminiInternalRequest = {
    model: 'claude-sonnet-4-6',
    project: 'synthetic-project',
    requestId: 'synthetic-request',
    userAgent: 'synthetic-test',
    request: { contents: [{ role: 'user', parts: [{ text: 'Synthetic test' }] }] },
  };
  beforeEach(() => {
    axiosMock.post.mockReset();
    axiosMock.isAxiosError.mockReturnValue(true);
    axiosMock.post.mockResolvedValue({ status: 200, headers: {}, data: { candidates: [] } });
    vi.stubEnv('PROXY_INTERNAL_BASE_URLS', '');
    vi.stubEnv('ANTIGRAVITY_INTERNAL_BASE_URLS', '');
    vi.stubEnv('PROXY_CONTEXT_CACHE_ENABLED', 'false');
    setServerConfig(DEFAULT_APP_CONFIG.proxy);
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(['unary', 'stream'])(
    'rejects conflicting aliases before restoring or sending internal %s history',
    async (mode) => {
      const input = structuredClone(body);
      input.request.contents.push({
        role: 'model',
        parts: [
          {
            text: 'reasoning',
            thought: true,
            thoughtSignature: 'synthetic-private-signature-A',
            thought_signature: 'synthetic-private-signature-B',
          },
        ],
      });
      const before = structuredClone(input);
      const restore = vi.spyOn(thoughtStoreService, 'prepareInternalRequest').mockResolvedValue();
      try {
        const client = new GeminiClient(new Upstream4xxCaptureService());
        if (mode === 'stream') {
          axiosMock.post.mockResolvedValue({ status: 200, headers: {}, data: Readable.from([]) });
        }
        const result =
          mode === 'stream'
            ? client.streamGenerateInternal(input, 'synthetic-token')
            : client.generateInternal(input, 'synthetic-token');
        const settled = result.then((value) => {
          if (value instanceof Readable) {
            value.destroy();
          }
          return value;
        });
        await expect(settled).rejects.toMatchObject({
          message:
            'Conflicting thoughtSignature and thought_signature at contents[1].parts[0]. Supply one signature value or equivalent aliases.',
        });
        expect(restore).not.toHaveBeenCalled();
        expect(axiosMock.post).not.toHaveBeenCalled();
        expect(input).toEqual(before);
      } finally {
        restore.mockRestore();
      }
    },
  );

  it.each(['generate', 'streamGenerate', 'warmupInternal'] as const)(
    'rejects conflicting aliases at the direct %s transport entry',
    async (operation) => {
      const input = structuredClone(body);
      input.request.contents = [
        {
          role: 'model',
          parts: [
            {
              text: 'reasoning',
              thoughtSignature: 'signature-A',
              thought_signature: 'signature-B',
            },
          ],
        },
      ];
      const before = structuredClone(input);
      const client = new GeminiClient(new Upstream4xxCaptureService());
      const result =
        operation === 'warmupInternal'
          ? client.warmupInternal(input, 'synthetic-token')
          : client[operation](input.model, input.request, 'synthetic-token');
      await expect(result).rejects.toMatchObject({
        message:
          'Conflicting thoughtSignature and thought_signature at contents[0].parts[0]. Supply one signature value or equivalent aliases.',
      });
      expect(axiosMock.post).not.toHaveBeenCalled();
      expect(input).toEqual(before);
    },
  );

  it('accepts equivalent raw/wrapped aliases and sends the same single wrapper for both', async () => {
    const raw = Buffer.from([0x08, 0x04, 0x12, ...Array<number>(80).fill(0x7f)]).toString('base64');
    const wrapped = Buffer.from(raw, 'utf8').toString('base64');
    const input = structuredClone(body);
    input.request.contents = [
      body.request.contents[0],
      {
        role: 'model',
        parts: [{ text: 'reasoning', thoughtSignature: raw, thought_signature: wrapped }],
      },
      { role: 'user', parts: [{ text: 'controlled follow-up' }] },
    ];
    const before = structuredClone(input);
    const client = new GeminiClient(new Upstream4xxCaptureService());
    await client.generateInternal(input, 'synthetic-token');

    expect(axiosMock.post.mock.calls[0]?.[1]).toBe(
      JSON.stringify({
        ...input,
        request: {
          ...input.request,
          contents: [
            input.request.contents[0],
            {
              role: 'model',
              parts: [{ text: 'reasoning', thoughtSignature: wrapped, thought_signature: wrapped }],
            },
            input.request.contents[2],
          ],
        },
      }),
    );
    expect(input).toEqual(before);
  });

  it('destroys the original upstream when the downstream captured stream is abandoned', async () => {
    const source = new Readable({ read() {} });
    axiosMock.post.mockResolvedValue({ status: 200, headers: {}, data: source });
    const client = new GeminiClient(new Upstream4xxCaptureService());
    const captured = await client.streamGenerateInternal(structuredClone(body), 'synthetic-token');
    try {
      if (!(captured instanceof Readable)) {
        throw new Error('Expected captured Node stream');
      }
      captured.destroy();
      await new Promise((resolve) => setImmediate(resolve));
      expect(source.destroyed).toBe(true);
    } finally {
      source.destroy();
    }
  });

  it('detaches a cancelled full request from pending shared explicit cache creation', async () => {
    vi.stubEnv('PROXY_CONTEXT_CACHE_ENABLED', 'true');
    let finish!: (resource: string | null) => void;
    const cache = vi.spyOn(explicitContextCacheManager, 'resolve').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const input = structuredClone(body);
    input.request.systemInstruction = { parts: [{ text: 's'.repeat(9000) }] };
    const controller = new AbortController();
    const client = new GeminiClient(new Upstream4xxCaptureService());
    const pending = client.generateInternal(
      input,
      'synthetic-token',
      undefined,
      undefined,
      controller.signal,
    );
    const outcome = pending.then(
      () => 'success',
      () => 'cancelled',
    );
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(cache).toHaveBeenCalledOnce();
      controller.abort();
      await new Promise((resolve) => setImmediate(resolve));
      expect(await Promise.race([outcome, Promise.resolve('still pending')])).toBe('cancelled');
      expect(axiosMock.post).not.toHaveBeenCalled();
    } finally {
      finish(null);
      await outcome;
      cache.mockRestore();
    }
  });

  it('rejects an already cancelled generation before restoring thought history', async () => {
    const restore = vi.spyOn(thoughtStoreService, 'prepareInternalRequest').mockResolvedValue();
    const controller = new AbortController();
    controller.abort();
    try {
      const client = new GeminiClient(new Upstream4xxCaptureService());
      await expect(
        client.generateInternal(
          structuredClone(body),
          'synthetic-token',
          undefined,
          undefined,
          controller.signal,
        ),
      ).rejects.toThrow(/cancelled|abort/iu);
      expect(restore).not.toHaveBeenCalled();
      expect(axiosMock.post).not.toHaveBeenCalled();
    } finally {
      restore.mockRestore();
    }
  });

  it('settles cancellation while thought restoration is pending without sending upstream', async () => {
    let finish!: () => void;
    const restore = vi.spyOn(thoughtStoreService, 'prepareInternalRequest').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const client = new GeminiClient(new Upstream4xxCaptureService());
    const request = client.generateInternal(
      structuredClone(body),
      'synthetic-token',
      undefined,
      undefined,
      controller.signal,
    );
    const outcome = request.then(
      () => 'success',
      () => 'cancelled',
    );
    try {
      controller.abort();
      await new Promise((resolve) => setImmediate(resolve));
      expect(await Promise.race([outcome, Promise.resolve('still pending')])).toBe('cancelled');
      expect(axiosMock.post).not.toHaveBeenCalled();
    } finally {
      finish();
      await outcome;
      restore.mockRestore();
    }
  });

  it('observes restored full context before a cached prefix is removed, without altering provider usage', async () => {
    vi.stubEnv('PROXY_CONTEXT_CACHE_ENABLED', 'true');
    const debug = vi.spyOn(diagnosticLogger, 'debug').mockImplementation(() => {});
    const restore = vi
      .spyOn(thoughtStoreService, 'prepareInternalRequest')
      .mockImplementation(async (request) => {
        request.request.contents.push({
          role: 'model',
          parts: [{ text: 'restored reasoning', thought: true, thoughtSignature: 's'.repeat(60) }],
        });
      });
    const cache = vi
      .spyOn(explicitContextCacheManager, 'resolve')
      .mockResolvedValue('cachedContents/synthetic');
    const input: GeminiInternalRequest = structuredClone(body);
    input.request.systemInstruction = { parts: [{ text: 's'.repeat(9000) }] };
    input.request.tools = [{ googleSearch: {} }];
    const provider = { candidates: [], usageMetadata: { promptTokenCount: 7, totalTokenCount: 7 } };
    axiosMock.post.mockResolvedValue({ status: 200, headers: {}, data: { response: provider } });
    try {
      const client = new GeminiClient(new Upstream4xxCaptureService());
      expect(await client.generateInternal(input, 'synthetic-token')).toEqual(provider);
      expect(restore).toHaveBeenCalledOnce();
      expect(cache).toHaveBeenCalledOnce();
      const diagnostic = debug.mock.calls
        .map(([message]) => message)
        .find((message) => typeof message === 'string' && message.startsWith('[ContextEstimate] '));
      const expectedFull = {
        ...input,
        request: {
          ...input.request,
          contents: [
            ...input.request.contents,
            {
              role: 'model',
              parts: [
                { text: 'restored reasoning', thought: true, thoughtSignature: 's'.repeat(60) },
              ],
            },
          ],
        },
      };
      const expectedSent = {
        ...expectedFull,
        request: {
          contents: expectedFull.request.contents,
          cachedContent: 'cachedContents/synthetic',
        },
      };
      expect(diagnostic).toEqual(
        '[ContextEstimate] ' +
          JSON.stringify({
            phase: 'physical-send',
            requestId: null,
            attempt: null,
            semanticEstimate: {
              algorithmVersion: 2,
              estimatedInputTokens: 2372,
              systemTokens: 2250,
              textTokens: 9,
              toolTokens: 5,
              thoughtMetadataTokens: 100,
              mediaTokens: 0,
              messageOverheadTokens: 8,
              signatureCharacters: 60,
              inlineMediaBytes: 0,
              unestimatedMediaParts: 0,
              messages: 2,
            },
            sentEstimate: estimateRequestContext(expectedSent),
            serializedBytes: Buffer.byteLength(JSON.stringify(expectedSent)),
            cachedPrefix: true,
            transformations: { entries: [], dropped: 0 },
            thoughtRestore: null,
          }),
      );
      expect(axiosMock.post).toHaveBeenCalledOnce();
      expect(axiosMock.post.mock.calls[0][1]).toEqual(JSON.stringify(expectedSent));
    } finally {
      debug.mockRestore();
      restore.mockRestore();
      cache.mockRestore();
    }
  });

  it.each(['unary', 'stream'])(
    'normalizes restored Claude signature formats before sending a %s request',
    async (mode) => {
      const rawSignature = Buffer.from([
        0x08,
        0x04,
        0x12,
        ...Array<number>(80).fill(0x7f),
      ]).toString('base64');
      const wrappedSignature = Buffer.from(rawSignature, 'utf8').toString('base64');
      const restore = vi
        .spyOn(thoughtStoreService, 'prepareInternalRequest')
        .mockImplementation(async (request) => {
          request.request.contents.push({
            role: 'model',
            parts: [{ text: 'restored reasoning', thought: true, thoughtSignature: rawSignature }],
          });
        });
      const input = structuredClone(body);
      const originalInput = structuredClone(input);
      try {
        const client = new GeminiClient(new Upstream4xxCaptureService());
        if (mode === 'stream') {
          axiosMock.post.mockResolvedValue({
            status: 200,
            headers: {},
            data: Readable.from([]),
          });
          const stream = await client.streamGenerateInternal(input, 'synthetic-token');
          for await (const _chunk of stream) {
            // Drain the transport so its audit lifecycle completes.
          }
        } else {
          await client.generateInternal(input, 'synthetic-token');
        }

        const wireBody = axiosMock.post.mock.calls[0]?.[1];
        let wireText = '';
        if (wireBody instanceof Readable) {
          for await (const chunk of wireBody) {
            wireText += chunk;
          }
        } else {
          wireText = String(wireBody);
        }
        const parsedBody = JSON.parse(wireText) as GeminiInternalRequest;
        const restoredPart = parsedBody.request.contents.at(-1)?.parts[0];

        expect(restoredPart?.thoughtSignature).toBe(wrappedSignature);
        expect(input).toStrictEqual(originalInput);
      } finally {
        restore.mockRestore();
      }
    },
  );

  it('normalizes known raw signatures on the replay-skip path without restoring history', async () => {
    const rawSignature = Buffer.from([0x08, 0x04, 0x12, ...Array<number>(80).fill(0x7f)]).toString(
      'base64',
    );
    const input = structuredClone(body);
    input.request.contents.push({
      role: 'model',
      parts: [{ text: 'reasoning', thought: true, thoughtSignature: rawSignature }],
    });
    input.request.contents.push({ role: 'user', parts: [{ text: 'controlled follow-up' }] });
    const before = structuredClone(input);
    const restore = vi.spyOn(thoughtStoreService, 'prepareInternalRequest').mockResolvedValue();
    try {
      const client = new GeminiClient(new Upstream4xxCaptureService());
      await client.generateInternal(input, 'synthetic-token', undefined, undefined, undefined, {
        thoughtReplay: 'skip',
      });
      expect(restore).not.toHaveBeenCalled();
      expect(input).toEqual(before);
      expect(axiosMock.post.mock.calls[0]?.[1]).toBe(
        JSON.stringify({
          ...input,
          request: {
            ...input.request,
            contents: [
              input.request.contents[0],
              {
                role: 'model',
                parts: [
                  {
                    text: 'reasoning',
                    thought: true,
                    thoughtSignature: Buffer.from(rawSignature, 'utf8').toString('base64'),
                  },
                ],
              },
              input.request.contents[2],
            ],
          },
        }),
      );
    } finally {
      restore.mockRestore();
    }
  });

  it('uses Daily first and falls back to Sandbox with the same request and token', async () => {
    axiosMock.post.mockRejectedValueOnce({
      response: { status: 404, headers: {}, data: { error: { status: 'NOT_FOUND' } } },
    });
    const client = new GeminiClient(new Upstream4xxCaptureService());
    await expect(client.generateInternal(body, 'synthetic-token')).resolves.toEqual({
      candidates: [],
    });
    expect(axiosMock.post.mock.calls.map(([url]) => url)).toEqual([
      'https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent',
      'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent',
    ]);
    expect(axiosMock.post.mock.calls[0][1]).toEqual(axiosMock.post.mock.calls[1][1]);
    expect(axiosMock.post.mock.calls.map(([, , options]) => options.headers.Authorization)).toEqual(
      ['Bearer synthetic-token', 'Bearer synthetic-token'],
    );
  });

  it.each(['json', 'stream'])(
    'stops endpoint failover on explicit long quota failures with a %s body and auditing disabled',
    async (mode) => {
      const message = JSON.stringify({
        error: {
          message: 'Individual quota reached',
          details: [{ reason: 'QUOTA_EXHAUSTED', metadata: { quotaResetDelay: '520035s' } }],
        },
      });
      axiosMock.post.mockRejectedValueOnce({
        response: {
          status: 429,
          headers: {},
          data: mode === 'stream' ? Readable.from([message]) : JSON.parse(message),
        },
      });
      const client = new GeminiClient(new Upstream4xxCaptureService());
      await expect(client.generateInternal(body, 'synthetic-token')).rejects.toMatchObject({
        status: 429,
        body: expect.stringContaining('QUOTA_EXHAUSTED'),
      });
      expect(axiosMock.post).toHaveBeenCalledTimes(1);
    },
  );

  it('honors an explicit endpoint order and does not probe another endpoint after success', async () => {
    vi.stubEnv(
      'PROXY_INTERNAL_BASE_URLS',
      'http://127.0.0.1:19001/first/,http://127.0.0.1:19002/second',
    );
    const client = new GeminiClient(new Upstream4xxCaptureService());
    await client.generateInternal(body, 'synthetic-token');
    expect(axiosMock.post.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:19001/first:generateContent',
    ]);
  });

  it('spends the same deadline across physical endpoint attempts', async () => {
    const client = new GeminiClient(new Upstream4xxCaptureService());
    let now = 1000;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, generation_timeout: 10 });
    axiosMock.post.mockImplementationOnce(async () => {
      now += 4000;
      throw { response: { status: 503, headers: {}, data: {} } };
    });
    try {
      await client.generateInternal(body, 'token');

      expect(axiosMock.post.mock.calls.map(([, , config]) => config.timeout)).toEqual([
        10000, 6000,
      ]);
    } finally {
      clock.mockRestore();
      client.onModuleDestroy();
    }
  });

  it('records a timed-out physical stream as timeout rather than a client disconnect', async () => {
    vi.useFakeTimers();
    setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, generation_timeout: 1 });
    const capture = vi.spyOn(errorProcessOwner, 'capture');
    const source = new PassThrough();
    const client = new GeminiClient(new Upstream4xxCaptureService());
    axiosMock.post.mockResolvedValueOnce({ status: 200, headers: {}, data: source });
    try {
      const stream = await client.streamGenerateInternal(body, 'token');
      const errors: unknown[] = [];
      stream.on('error', (error: unknown) => errors.push(error));
      await vi.advanceTimersByTimeAsync(1001);

      expect(errors).toMatchObject([{ name: 'GenerationDeadlineExceededError' }]);
      expect(source.destroyed).toBe(true);
      expect(capture.mock.calls.filter(([input]) => input.stage === 'upstream-attempt')).toEqual([
        [
          expect.objectContaining({
            category: 'timeout',
            error: expect.objectContaining({ name: 'GenerationDeadlineExceededError' }),
          }),
        ],
      ]);
      client.onModuleDestroy();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      capture.mockRestore();
      client.onModuleDestroy();
      vi.useRealTimers();
    }
  });

  it('does not dispatch another endpoint after the logical deadline has been spent', async () => {
    let now = 1000;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, generation_timeout: 1 });
    axiosMock.post.mockImplementationOnce(async () => {
      now += 1001;
      throw { response: { status: 503, headers: {}, data: {} } };
    });
    try {
      await expect(
        new GeminiClient(new Upstream4xxCaptureService()).generateInternal(body, 'token'),
      ).rejects.toMatchObject({ name: 'GenerationDeadlineExceededError', code: 'ETIMEDOUT' });

      expect(axiosMock.post).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
    }
  });

  it('canonicalizes and deduplicates endpoint overrides while preserving candidate order', async () => {
    vi.stubEnv(
      'PROXY_INTERNAL_BASE_URLS',
      'https://ONE.invalid:443/v1internal/,https://one.invalid/v1internal,http://two.invalid/v1internal',
    );
    axiosMock.post.mockRejectedValueOnce({ response: { status: 503, headers: {}, data: {} } });
    const client = new GeminiClient(new Upstream4xxCaptureService());

    await client.generateInternal(body, 'synthetic-token');

    expect(axiosMock.post.mock.calls.map(([url]) => url)).toEqual([
      'https://one.invalid/v1internal:generateContent',
      'http://two.invalid/v1internal:generateContent',
    ]);
  });

  it.each([
    'not-a-url',
    'ftp://upstream.invalid/v1internal',
    'https://private-user:private-secret@upstream.invalid/v1internal',
    'https://upstream.invalid/v1internal?token=private-secret',
    'https://upstream.invalid/v1internal#fragment',
    'https://upstream.invalid/v1internal?',
    'https://upstream.invalid/v1internal#',
    'https:upstream.invalid/v1internal',
    'https://upstream.invalid\\wrong-path',
    'https://one.invalid/v1internal,,https://two.invalid/v1internal',
    'https://upstream.invalid/\npath',
    Array.from({ length: 9 }, (_, index) => `https://upstream-${index}.invalid/v1internal`).join(
      ',',
    ),
    `https://upstream.invalid/${'a'.repeat(8192)}`,
  ])('refuses invalid internal endpoint configuration before any send (%#)', async (configured) => {
    vi.stubEnv('PROXY_INTERNAL_BASE_URLS', configured);
    const client = new GeminiClient(new Upstream4xxCaptureService());

    const request = client.generateInternal(body, 'synthetic-token');

    await expect(request).rejects.toMatchObject({ name: 'UpstreamEndpointConfigurationError' });
    await expect(request).rejects.not.toThrow('private-secret');
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  it('keeps primary override precedence over the alias without probing defaults', async () => {
    vi.stubEnv('PROXY_INTERNAL_BASE_URLS', 'http://primary.invalid/prefix');
    vi.stubEnv('ANTIGRAVITY_INTERNAL_BASE_URLS', 'http://alias.invalid/other');
    const client = new GeminiClient(new Upstream4xxCaptureService());

    await client.generateInternal(body, 'synthetic-token');

    expect(axiosMock.post.mock.calls.map(([url]) => url)).toEqual([
      'http://primary.invalid/prefix:generateContent',
    ]);
  });

  it('keeps a root endpoint slash so the method cannot be parsed as a port', async () => {
    vi.stubEnv('PROXY_INTERNAL_BASE_URLS', 'http://root.invalid');
    const client = new GeminiClient(new Upstream4xxCaptureService());

    await client.generateInternal(body, 'synthetic-token');

    expect(axiosMock.post.mock.calls.map(([url]) => url)).toEqual([
      'http://root.invalid/:generateContent',
    ]);
  });

  it.each([
    'ERR_CANCELED',
    'ABORT_ERR',
    'ERR_INVALID_URL',
    'ERR_BAD_OPTION_VALUE',
    'ERR_BAD_OPTION',
    'ERR_NOT_SUPPORT',
  ])('does not rotate endpoints after local Axios failure %s', async (code) => {
    const error = Object.assign(new Error('local request failure'), { code });
    axiosMock.post.mockRejectedValueOnce(error);
    const client = new GeminiClient(new Upstream4xxCaptureService());

    await expect(client.generateInternal(body, 'synthetic-token')).rejects.toThrow();

    expect(axiosMock.post).toHaveBeenCalledTimes(1);
  });

  it.each(['unary', 'stream'])(
    'uses the Hub HTTP identity for %s content generation despite header overrides',
    async (mode) => {
      const client = new GeminiClient(new Upstream4xxCaptureService());
      const headers = {
        'uSeR-aGeNt': 'untrusted-client/1.0',
        'anthropic-beta': 'interleaved-thinking-2025-05-14',
      };
      if (mode === 'stream') {
        axiosMock.post.mockResolvedValue({ status: 200, headers: {}, data: Readable.from([]) });
        const stream = await client.streamGenerateInternal(
          body,
          'synthetic-token',
          undefined,
          headers,
        );
        for await (const _chunk of stream) {
          // Drain the transport so its audit lifecycle completes.
        }
      } else {
        await client.generateInternal(body, 'synthetic-token', undefined, headers);
      }

      expect(axiosMock.post).toHaveBeenCalledTimes(1);
      const [, wireBody, options] = axiosMock.post.mock.calls[0];
      const platform = process.platform === 'win32' ? 'windows' : process.platform;
      const arch = process.arch === 'x64' ? 'amd64' : process.arch;
      expect(options.headers).toEqual({
        Authorization: 'Bearer synthetic-token',
        'Content-Type': 'application/json',
        'anthropic-beta': 'interleaved-thinking-2025-05-14',
        'User-Agent': `antigravity/hub/2.17.0 (aidev_client; os_type=${platform}; arch=${arch}; cl=986210228)`,
      });
      let text = '';
      if (wireBody instanceof Readable) {
        for await (const chunk of wireBody) {
          text += chunk;
        }
      } else {
        text = wireBody;
      }
      // HTTP client identity must not rewrite the separately owned request envelope.
      expect(JSON.parse(text)).toEqual(body);
    },
  );
});
