import { createServer, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import axios from 'axios';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GeminiClient } from '@/server/gateway/modules/gemini/gemini-client.service';
import { Upstream4xxCaptureService } from '@/server/gateway/common/upstream-4xx-capture.service';
import { UpstreamAttemptTimingSchema } from '@/modules/proxy-gateway/audit/upstream-attempt-timing';
import type { CompleteUpstreamAttemptInput } from '@/modules/proxy-gateway/audit/traffic-audit.types';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { setServerConfig } from '@/server/server-config';

const audit = vi.hoisted(() => ({
  beginAttemptSse: vi.fn(() => null),
  completeAttempt: vi.fn<(_handle: unknown, input: CompleteUpstreamAttemptInput) => void>(),
}));
vi.mock('@/modules/proxy-gateway/audit/traffic-audit.service', () => ({
  trafficAuditService: audit,
}));
vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<
    typeof import('@/server/gateway/common/utils/request-user-agent')
  >()),
  resolveRequestUserAgent: async () => 'controlled-timing-fixture',
  buildContentRequestUserAgent: () => 'controlled-timing-fixture',
}));

const request = {
  model: 'gemini-3-flash',
  requestId: 'timing-http',
  userAgent: 'fixture',
  request: { contents: [{ role: 'user', parts: [{ text: 'Controlled timing request.' }] }] },
};
const answer = {
  response: {
    candidates: [{ content: { role: 'model', parts: [{ text: 'Answer' }] }, finishReason: 'STOP' }],
  },
};
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const nativePost = axios.post.bind(axios);
beforeEach(() => {
  audit.completeAttempt.mockClear();
  vi.stubEnv('PROXY_CONTEXT_CACHE_ENABLED', 'false');
  for (const name of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
  ]) {
    vi.stubEnv(name, '');
  }
  vi.spyOn(axios, 'post').mockImplementation((url, body, config) =>
    nativePost(url, body, { ...config, adapter: 'http' }),
  );
  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, request_timeout: 10 });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setServerConfig(DEFAULT_APP_CONFIG.proxy);
});

async function fixture(
  handle: (url: string, response: ServerResponse) => void,
  run: (client: GeminiClient, base: string) => Promise<void>,
) {
  const server = createServer((incoming, response) => {
    incoming.resume();
    incoming.once('end', () => handle(incoming.url ?? '', response));
  });
  const client = new GeminiClient(new Upstream4xxCaptureService());
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected isolated loopback listener');
    }
    const base = `http://127.0.0.1:${address.port}`;
    vi.stubEnv('PROXY_INTERNAL_BASE_URLS', base);
    await run(client, base);
  } finally {
    client.onModuleDestroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
async function consume(stream: unknown): Promise<string> {
  if (!(stream instanceof Readable)) {
    throw new Error('Expected upstream stream');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString();
}
function observed(index = 0) {
  const input = audit.completeAttempt.mock.calls[index]?.[1];
  const timing = UpstreamAttemptTimingSchema.parse(input?.timing);
  expect(timing.uploadFinishedMs).toEqual(expect.any(Number));
  expect(timing.responseHeadersMs).toEqual(expect.any(Number));
  expect(timing.firstByteMs).toEqual(expect.any(Number));
  return timing;
}

it('records real upload, headers and first byte for unary output without inventing token timing', async () => {
  await fixture(
    (_url, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(answer));
    },
    async (client) => {
      expect(await client.generateInternal(request, 'synthetic-token')).toEqual(answer.response);
      expect(audit.completeAttempt).toHaveBeenCalledTimes(1);
      expect(observed().firstUsableOutputMs).toBeNull();
    },
  );
});

it.each([true, false])(
  'records streamed bytes and only validated usable output (output=%s)',
  async (usable) => {
    const thinking = {
      response: {
        candidates: [{ content: { role: 'model', parts: [{ thought: true, text: 'Reasoning' }] } }],
      },
    };
    const body =
      ': heartbeat\n\n' +
      frame(thinking) +
      frame(usable ? answer : { error: { code: 500, message: 'Synthetic error' } });
    await fixture(
      (_url, response) => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(body);
      },
      async (client) => {
        await consume(await client.streamGenerateInternal(request, 'synthetic-token'));
        expect(audit.completeAttempt).toHaveBeenCalledTimes(1);
        const timing = observed();
        if (usable) {
          expect(timing.firstUsableOutputMs).toEqual(expect.any(Number));
          expect(timing.firstUsableOutputMs).toBeGreaterThanOrEqual(timing.firstByteMs!);
        } else {
          expect(timing.firstUsableOutputMs).toBeNull();
          expect(audit.completeAttempt.mock.calls[0]?.[1].outcome).toBe('upstream_error');
        }
      },
    );
  },
);

it('records each failed and successful physical endpoint attempt once', async () => {
  await fixture(
    (url, response) => {
      response.writeHead(url.startsWith('/first') ? 503 : 200, {
        'Content-Type': 'application/json',
      });
      response.end(
        JSON.stringify(
          url.startsWith('/first') ? { error: { message: 'Synthetic unavailable' } } : answer,
        ),
      );
    },
    async (client, base) => {
      vi.stubEnv('PROXY_INTERNAL_BASE_URLS', `${base}/first,${base}/second`);
      await client.generateInternal(request, 'synthetic-token');
      expect(audit.completeAttempt.mock.calls.map((call) => call[1].outcome)).toEqual([
        'upstream_error',
        'completed',
      ]);
      expect(observed(0).firstUsableOutputMs).toBeNull();
      expect(observed(1).firstUsableOutputMs).toBeNull();
    },
  );
});

it('retains observed output timing when a stream consumer closes early', async () => {
  await fixture(
    (_url, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(
        frame({
          response: { candidates: [{ content: { role: 'model', parts: [{ text: 'Partial' }] } }] },
        }),
      );
    },
    async (client) => {
      const stream = await client.streamGenerateInternal(request, 'synthetic-token');
      if (!(stream instanceof Readable)) {
        throw new Error('Expected upstream stream');
      }
      const closed = new Promise<void>((resolve) => stream.once('close', resolve));
      await new Promise<void>((resolve, reject) => {
        stream.once('error', reject);
        stream.once('data', () => {
          stream.destroy();
          resolve();
        });
      });
      await closed;
      expect(audit.completeAttempt).toHaveBeenCalledTimes(1);
      expect(audit.completeAttempt.mock.calls[0]?.[1]).toMatchObject({
        outcome: 'client_disconnected',
        partial: true,
      });
      expect(observed().firstUsableOutputMs).toEqual(expect.any(Number));
    },
  );
});

it('records unavailable header and body stages when cancellation stops an admitted send', async () => {
  const cancellation = new AbortController();
  await fixture(
    () => cancellation.abort(),
    async (client) => {
      await expect(
        client.generateInternal(
          request,
          'synthetic-token',
          undefined,
          undefined,
          cancellation.signal,
        ),
      ).rejects.toBeDefined();
      expect(audit.completeAttempt).toHaveBeenCalledTimes(1);
      const input = audit.completeAttempt.mock.calls[0]?.[1];
      expect(input).toMatchObject({ outcome: 'client_cancelled', partial: true });
      expect(UpstreamAttemptTimingSchema.parse(input?.timing)).toEqual({
        version: 1,
        uploadFinishedMs: expect.any(Number),
        responseHeadersMs: null,
        firstByteMs: null,
        firstUsableOutputMs: null,
      });
    },
  );
});

it('observes warmup content stages without a generation deadline owner', async () => {
  await fixture(
    (_url, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(frame(answer));
    },
    async (client) => {
      await client.warmupInternal(request, 'synthetic-token');
      await vi.waitFor(() => expect(audit.completeAttempt).toHaveBeenCalledTimes(1));
      const timing = UpstreamAttemptTimingSchema.parse(
        audit.completeAttempt.mock.calls[0]?.[1].timing,
      );
      expect(timing.uploadFinishedMs).toEqual(expect.any(Number));
      expect(timing.responseHeadersMs).toEqual(expect.any(Number));
    },
  );
});

it.each([true, false])('records public Gemini transport stages (stream=%s)', async (streaming) => {
  await fixture(
    (_url, response) => {
      response.writeHead(200, {
        'Content-Type': streaming ? 'text/event-stream' : 'application/json',
      });
      response.end(streaming ? frame(answer) : JSON.stringify(answer.response));
    },
    async (client, base) => {
      // Redirect the public API's fixed origin only at Axios, retaining its real Node transport.
      vi.mocked(axios.post).mockImplementation((_url, body, config) =>
        nativePost(base, body, { ...config, adapter: 'http' }),
      );
      if (streaming) {
        await consume(
          await client.streamGenerate(request.model, request.request, 'synthetic-token'),
        );
      } else {
        expect(await client.generate(request.model, request.request, 'synthetic-token')).toEqual(
          answer.response,
        );
      }
      expect(audit.completeAttempt).toHaveBeenCalledTimes(1);
      const timing = observed();
      expect(timing.firstUsableOutputMs).toEqual(streaming ? expect.any(Number) : null);
    },
  );
});
