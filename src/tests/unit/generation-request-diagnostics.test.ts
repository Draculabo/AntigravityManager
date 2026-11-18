import axios from 'axios';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runWithTrafficAuditRequestContext } from '@/modules/proxy-gateway/audit/traffic-audit-context';
import { explicitContextCacheManager } from '@/server/gateway/modules/gemini/explicit-context-cache.store';
import { createGeminiRequestEnvelope } from '@/server/gateway/modules/gemini/gemini-request-envelope';
import { GeminiClient } from '@/server/gateway/modules/gemini/gemini-client.service';
import { Upstream4xxCaptureService } from '@/server/gateway/common/upstream-4xx-capture.service';
import { estimateRequestContext } from '@/server/gateway/common/request-context-estimate';
import { thoughtStoreService } from '@/modules/proxy-gateway/thought-store/thought-store.service';
import { logger } from '@/shared/logging/logger';
import type { GeminiInternalRequest } from '@/modules/proxy-gateway/antigravity/types';

vi.mock('@/server/gateway/common/utils/request-user-agent', () => ({
  resolveRequestUserAgent: async () => 'controlled-diagnostics/0.0.0',
  buildContentRequestUserAgent: () => 'controlled-diagnostics/0.0.0',
}));

const diagnosticSchema = z.object({
  phase: z.literal('physical-send'),
  attempt: z.number(),
  semanticEstimate: z.unknown(),
  sentEstimate: z.unknown(),
  serializedBytes: z.number(),
  cachedPrefix: z.boolean(),
  transformations: z.object({ entries: z.array(z.unknown()), dropped: z.number() }),
});

function context() {
  return {
    attemptSequence: 0,
    parent: null,
    thoughtSessionKey: 'controlled',
    thoughtSessionStable: false,
  };
}

function envelope(): GeminiInternalRequest {
  return createGeminiRequestEnvelope(
    'gemini-3-flash',
    {
      systemInstruction: {
        parts: [
          {
            text: 'You are an AI assistant built by Example.\nx-anthropic-billing-header: private-fixture\nPreserve business rules.',
          },
        ],
      },
      contents: [
        { role: 'user', parts: [{ text: '  ' }, { text: 'Fixture 用户 request.' }] },
        { role: 'model', parts: [{ text: 'Partial answer:  ' }] },
      ],
    },
    'controlled-project',
    'agent',
    'controlled-agent',
    'controlled-request',
  );
}

async function wire(value: unknown): Promise<string> {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Readable) {
    let text = '';
    for await (const chunk of value) {
      text +=
        typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
    }
    return text;
  }
  throw new Error('Expected a serialized generation fixture');
}

function rejection(status: number) {
  return new axios.AxiosError('controlled failure', 'ERR_BAD_RESPONSE', undefined, undefined, {
    config: {} as never,
    data: { error: { message: 'cachedContent not found' } },
    headers: {},
    status,
    statusText: 'fixture',
  });
}

beforeEach(() => {
  vi.stubEnv('PROXY_CONTEXT_CACHE_ENABLED', 'false');
  vi.stubEnv('PROXY_INTERNAL_BASE_URLS', 'https://one.invalid/v1internal');
  vi.spyOn(thoughtStoreService, 'prepareInternalRequest').mockResolvedValue();
  vi.spyOn(thoughtStoreService, 'captureGeminiResponse').mockImplementation(() => undefined);
});
afterEach(() => {
  explicitContextCacheManager.clear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('generation diagnostics at the actual send boundary', () => {
  it.each([false, true])(
    'matches bytes received by an isolated HTTP upstream, stream=%s',
    async (stream) => {
      const received: Buffer[] = [];
      const server = createServer(async (request, response) => {
        for await (const chunk of request) {
          received.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        response.writeHead(200, {
          'Content-Type': stream ? 'text/event-stream' : 'application/json',
        });
        response.end(
          stream ? 'data: {"response":{"candidates":[]}}\n\n' : '{"response":{"candidates":[]}}',
        );
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      try {
        const address = server.address();
        if (!address || typeof address === 'string') {
          throw new Error('Expected assigned loopback port');
        }
        vi.stubEnv('PROXY_INTERNAL_BASE_URLS', `http://127.0.0.1:${address.port}/v1internal`);
        const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
        const originalPost = axios.post.bind(axios);
        vi.spyOn(axios, 'post').mockImplementation((url, data, config) =>
          originalPost(url, data, { ...config, adapter: 'http' }),
        );
        await runWithTrafficAuditRequestContext(context(), async () => {
          const client = new GeminiClient(new Upstream4xxCaptureService());
          if (stream) {
            const response = await client.streamGenerateInternal(envelope(), 'controlled-token');
            for await (const _chunk of response) {
              /* Drain and release the real response connection. */
            }
          } else {
            await client.generateInternal(envelope(), 'controlled-token');
          }
        });
        const line = debug.mock.calls
          .map(([value]) => value)
          .find((value) => typeof value === 'string' && value.startsWith('[ContextEstimate] '));
        expect(typeof line).toBe('string');
        const report = diagnosticSchema.parse(
          JSON.parse(String(line).slice('[ContextEstimate] '.length)),
        );
        const bytes = Buffer.concat(received);
        const actual: GeminiInternalRequest = JSON.parse(bytes.toString('utf8'));
        const requestKeys = Object.keys(actual.request);
        expect(requestKeys.indexOf('systemInstruction')).toBeLessThan(
          requestKeys.indexOf('contents'),
        );
        expect(report).toMatchObject({
          attempt: 1,
          serializedBytes: bytes.length,
          semanticEstimate: estimateRequestContext(actual),
          sentEstimate: estimateRequestContext(actual),
        });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );

  it('estimates after restored thought and repeats exact diagnostics for each endpoint send', async () => {
    vi.stubEnv(
      'PROXY_INTERNAL_BASE_URLS',
      'https://one.invalid/v1internal,https://two.invalid/v1internal',
    );
    vi.mocked(thoughtStoreService.prepareInternalRequest).mockImplementation(async (body) => {
      body.request.contents[1].parts.unshift({
        text: 'restored controlled thought',
        thought: true,
        thoughtSignature: 'opaque-controlled',
      });
    });
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const sent: string[] = [];
    vi.spyOn(axios, 'post').mockImplementation(async (_url, value) => {
      sent.push(await wire(value));
      if (sent.length === 1) {
        throw rejection(503);
      }
      return { status: 200, headers: {}, data: { candidates: [] } };
    });
    await runWithTrafficAuditRequestContext(context(), () =>
      new GeminiClient(new Upstream4xxCaptureService()).generateInternal(
        envelope(),
        'controlled-token',
      ),
    );
    const reports = debug.mock.calls.flatMap(([message]) =>
      typeof message === 'string' && message.startsWith('[ContextEstimate] ')
        ? [diagnosticSchema.parse(JSON.parse(message.slice('[ContextEstimate] '.length)))]
        : [],
    );
    expect(reports).toHaveLength(2);
    for (const [index, report] of reports.entries()) {
      const actual: GeminiInternalRequest = JSON.parse(sent[index]);
      expect(report).toMatchObject({
        attempt: index + 1,
        semanticEstimate: estimateRequestContext(actual),
        sentEstimate: estimateRequestContext(actual),
        serializedBytes: Buffer.byteLength(sent[index]),
      });
      expect(report.sentEstimate).toMatchObject({
        thoughtMetadataTokens: 100,
        signatureCharacters: 17,
      });
    }
    expect(JSON.stringify(reports)).not.toContain('restored controlled thought');
    expect(JSON.stringify(reports)).not.toContain('opaque-controlled');
  });

  it('does not emit generation diagnostics for count requests or aborted dispatch', async () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const post = vi
      .spyOn(axios, 'post')
      .mockResolvedValue({ status: 200, headers: {}, data: { totalTokens: 3 } });
    const client = new GeminiClient(new Upstream4xxCaptureService());
    await client.countTokensInternal(
      {
        request: {
          model: 'gemini-3-flash',
          contents: [{ role: 'user', parts: [{ text: 'count fixture' }] }],
        },
      },
      'controlled-token',
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.generateInternal(
        envelope(),
        'controlled-token',
        undefined,
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(post).toHaveBeenCalledTimes(1);
    expect(
      debug.mock.calls.filter(
        ([message]) => typeof message === 'string' && message.startsWith('[ContextEstimate] '),
      ),
    ).toEqual([]);
  });

  it.each([false, true])('observes the serialized unary/stream body, stream=%s', async (stream) => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const sent: string[] = [];
    const post = vi.spyOn(axios, 'post').mockImplementation(async (_url, value) => {
      sent.push(await wire(value));
      return { status: 200, headers: {}, data: stream ? Readable.from([]) : { candidates: [] } };
    });
    const capture = new Upstream4xxCaptureService();
    const client = new GeminiClient(capture);
    const state = context();
    await runWithTrafficAuditRequestContext(state, async () => {
      const body = envelope();
      if (stream) {
        const response = await client.streamGenerateInternal(body, 'controlled-token');
        for await (const _chunk of response) {
          /* Complete the controlled empty stream. */
        }
      } else {
        await client.generateInternal(body, 'controlled-token');
      }
    });
    expect(post).toHaveBeenCalledTimes(1);
    const rows = debug.mock.calls.flatMap(([message]) =>
      typeof message === 'string' && message.startsWith('[ContextEstimate] ')
        ? [JSON.parse(message.slice('[ContextEstimate] '.length))]
        : [],
    );
    expect(rows).toHaveLength(1);
    const report = diagnosticSchema.parse(rows[0]);
    const transmitted: GeminiInternalRequest = JSON.parse(sent[0]);
    expect(report).toEqual({
      phase: 'physical-send',
      attempt: 1,
      semanticEstimate: estimateRequestContext(transmitted),
      sentEstimate: estimateRequestContext(transmitted),
      serializedBytes: Buffer.byteLength(sent[0], 'utf8'),
      cachedPrefix: false,
      transformations: {
        entries: [
          { kind: 'billing-metadata-removed', surface: 'system', message: null, part: 0 },
          { kind: 'identity-normalized', surface: 'system', message: null, part: 0 },
          { kind: 'empty-text-removed', surface: 'contents', message: 0, part: 0 },
          { kind: 'prefill-tail-appended', surface: 'contents', message: 2, part: null },
        ],
        dropped: 0,
      },
    });
    expect(JSON.stringify(report)).not.toContain('private-fixture');
    expect(JSON.stringify(report)).not.toContain('Fixture 用户');
  });

  it('distinguishes full semantic input from cached wire input and cache rejection fallback', async () => {
    vi.stubEnv('PROXY_CONTEXT_CACHE_ENABLED', 'true');
    vi.stubEnv('PROXY_CONTEXT_CACHE_MIN_CHARACTERS', '1');
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const sent: string[] = [];
    vi.spyOn(axios, 'post').mockImplementation(async (url, value) => {
      if (String(url).endsWith('/cachedContents')) {
        return {
          data: {
            expireTime: '2099-01-01T00:00:00Z',
            name: 'projects/fixture/locations/us-central1/cachedContents/controlled',
          },
        };
      }
      sent.push(await wire(value));
      if (sent.length === 1) {
        throw rejection(404);
      }
      return { status: 200, headers: {}, data: { candidates: [] } };
    });
    const capture = new Upstream4xxCaptureService();
    vi.spyOn(capture, 'capture').mockResolvedValue();
    await runWithTrafficAuditRequestContext(context(), () =>
      new GeminiClient(capture).generateInternal(envelope(), 'controlled-token'),
    );
    const reports = debug.mock.calls.flatMap(([message]) =>
      typeof message === 'string' && message.startsWith('[ContextEstimate] ')
        ? [diagnosticSchema.parse(JSON.parse(message.slice('[ContextEstimate] '.length)))]
        : [],
    );
    expect(reports).toHaveLength(2);
    const full: GeminiInternalRequest = JSON.parse(sent[1]);
    for (const [index, report] of reports.entries()) {
      const actual: GeminiInternalRequest = JSON.parse(sent[index]);
      expect(report).toMatchObject({
        phase: 'physical-send',
        attempt: index + 2,
        semanticEstimate: estimateRequestContext(full),
        sentEstimate: estimateRequestContext(actual),
        serializedBytes: Buffer.byteLength(sent[index]),
        cachedPrefix: index === 0,
      });
    }
    expect(reports[0].semanticEstimate).not.toEqual(reports[0].sentEstimate);
    expect(reports[1].semanticEstimate).toEqual(reports[1].sentEstimate);
  });
});
