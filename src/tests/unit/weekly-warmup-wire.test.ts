import axios from 'axios';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProxyGatewayWeeklyWarmupExecutor } from '@/modules/proxy-gateway/weekly-warmup-executor';

let server: Server;
let packets: { url: string; body: unknown; authorization?: string }[];
let status = 200;
let disconnectStream = false;
let onRequest: (() => void) | undefined;
const originalAdapter = axios.defaults.adapter;

beforeEach(async () => {
  packets = [];
  status = 200;
  disconnectStream = false;
  onRequest = undefined;
  axios.defaults.adapter = axios.getAdapter('http');
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    packets.push({
      url: request.url ?? '',
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      authorization: request.headers.authorization,
    });
    if (onRequest) {
      onRequest();
      return;
    }
    if (disconnectStream && request.url?.includes('streamGenerateContent')) {
      request.socket.destroy();
      return;
    }
    response.writeHead(status, { 'content-type': 'text/event-stream' });
    response.end('data: {"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]}}]}\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Missing test server address');
  }
  vi.stubEnv('PROXY_INTERNAL_BASE_URLS', `http://127.0.0.1:${address.port}/v1internal`);
});

afterEach(async () => {
  axios.defaults.adapter = originalAdapter;
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const request = {
  model: 'gemini-3-flash' as const,
  accessToken: 'synthetic-warmup-token',
  projectId: 'synthetic-project',
};

describe('weekly warmup actual HTTP transport', () => {
  it('sends the complete Flash request through the streaming internal endpoint', async () => {
    await new ProxyGatewayWeeklyWarmupExecutor().warmup(request);
    expect(packets).toEqual([
      {
        url: '/v1internal:streamGenerateContent?alt=sse',
        authorization: 'Bearer synthetic-warmup-token',
        body: {
          requestId: expect.stringMatching(/^agent\/\d+\/[a-f0-9]{8}$/),
          model: 'gemini-3-flash',
          project: 'synthetic-project',
          userAgent: 'antigravity',
          requestType: 'agent',
          enabledCreditTypes: ['GOOGLE_ONE_AI'],
          request: {
            contents: [{ role: 'user', parts: [{ text: 'Say hi' }] }],
            generationConfig: { temperature: 0, topK: 40, topP: 1 },
          },
        },
      },
    ]);
  });

  it('falls back to non-streaming only after a transport failure, keeping the identical body', async () => {
    disconnectStream = true;
    await new ProxyGatewayWeeklyWarmupExecutor().warmup(request);
    expect(packets.map((packet) => packet.url)).toEqual([
      '/v1internal:streamGenerateContent?alt=sse',
      '/v1internal:generateContent',
    ]);
    expect(packets[1].body).toEqual(packets[0].body);
  });

  it('does not turn an HTTP rejection into a successful warmup or a second generation', async () => {
    status = 403;
    await expect(new ProxyGatewayWeeklyWarmupExecutor().warmup(request)).rejects.toThrow(
      'HTTP 403',
    );
    expect(packets).toHaveLength(1);
  });

  it('does not send an already cancelled request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      new ProxyGatewayWeeklyWarmupExecutor().warmup({ ...request, signal: controller.signal }),
    ).rejects.toThrow('cancelled');
    expect(packets).toEqual([]);
  });

  it('aborts an in-flight request without a fallback generation', async () => {
    const controller = new AbortController();
    onRequest = () => controller.abort();
    await expect(
      new ProxyGatewayWeeklyWarmupExecutor().warmup({ ...request, signal: controller.signal }),
    ).rejects.toThrow('cancelled');
    expect(packets).toHaveLength(1);
  });

  it('cancels the pending transport when its 60-second deadline expires', async () => {
    const schedule = globalThis.setTimeout;
    let expire: (() => void) | undefined;
    const timer = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((callback, delay, ...args) => {
        if (delay === 60000 && typeof callback === 'function') {
          expire ??= () => callback(...args);
        }
        return schedule(callback, delay, ...args);
      });
    onRequest = () => {
      if (!expire) {
        throw new Error('Warmup deadline was not installed');
      }
      expire();
    };
    try {
      await expect(new ProxyGatewayWeeklyWarmupExecutor().warmup(request)).rejects.toThrow(
        'cancelled',
      );
      expect(packets).toHaveLength(1);
    } finally {
      timer.mockRestore();
    }
  });
});
