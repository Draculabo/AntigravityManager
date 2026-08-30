import axios from 'axios';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiClient } from '@/modules/proxy-gateway/server/modules/gemini/gemini-client.service';
import { Upstream4xxCaptureService } from '@/modules/proxy-gateway/server/common/upstream-4xx-capture.service';
import { explicitContextCacheManager } from '@/modules/proxy-gateway/server/modules/gemini/explicit-context-cache.store';
import type { GeminiInternalRequest } from '@/modules/proxy-gateway/antigravity/types';

let server: Server;
let packets: { url: string; body: unknown }[];
let rejectCreation = false;
let rejectCachedGeneration = false;
const originalAdapter = axios.defaults.adapter;
beforeEach(async () => {
  packets = [];
  rejectCreation = false;
  rejectCachedGeneration = false;
  // Use Axios's real Node HTTP transport and a loopback upstream, not a client mock.
  axios.defaults.adapter = axios.getAdapter('http');
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    packets.push({ url: request.url ?? '', body: JSON.parse(text) });
    const cache = request.url?.endsWith('/cachedContents');
    response.setHeader('content-type', 'application/json');
    if (
      (cache && rejectCreation) ||
      (!cache && rejectCachedGeneration && text.includes('cachedContent'))
    ) {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { message: 'cachedContent not found' } }));
    } else {
      response.end(
        JSON.stringify(
          cache
            ? {
                name: 'projects/test/locations/test/cachedContents/fixture',
                expireTime: '2099-01-01T00:00:00Z',
              }
            : { candidates: [] },
        ),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Missing test server port');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  vi.stubEnv('PROXY_CONTEXT_CACHE_ENABLED', 'true');
  vi.stubEnv('PROXY_CONTEXT_CACHE_MIN_CHARACTERS', '1');
  vi.stubEnv('PROXY_CONTEXT_CACHE_BASE_URL', baseUrl);
  vi.stubEnv('PROXY_INTERNAL_BASE_URLS', `${baseUrl}/v1internal`);
});
afterEach(async () => {
  axios.defaults.adapter = originalAdapter;
  explicitContextCacheManager.clear();
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
function body(): GeminiInternalRequest {
  return {
    model: 'gemini-3-flash',
    project: 'test',
    requestId: 'synthetic-fixture',
    requestType: 'agent',
    userAgent: 'test',
    request: {
      contents: [{ role: 'user', parts: [{ text: 'Synthetic test' }] }],
      systemInstruction: { parts: [{ text: 'Only test data' }] },
      tools: [{ functionDeclarations: [{ name: 'read_fixture' }] }],
      toolConfig: {
        functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['read_fixture'] },
        includeServerSideToolInvocations: true,
      },
      tool_config: {
        function_calling_config: { mode: 'ANY', allowed_function_names: ['read_fixture'] },
        include_server_side_tool_invocations: true,
      },
    },
  };
}
describe('tool configuration at the actual HTTP serialization boundary', () => {
  it('creates once, reuses cache and removes both aliases from every cache-backed generation', async () => {
    const client = new GeminiClient(new Upstream4xxCaptureService());
    const request = body();
    await client.generateInternal(request, 'synthetic-not-a-credential');
    await client.generateInternal(request, 'synthetic-not-a-credential');
    expect(packets).toHaveLength(3);
    expect(packets[0].url).toMatch(/\/cachedContents$/);
    expect(packets[0].body).toMatchObject({ toolConfig: request.request.toolConfig });
    expect(packets[0].body).not.toHaveProperty('tool_config');
    for (const packet of packets.slice(1)) {
      expect(packet.body).toEqual({
        ...request,
        request: {
          contents: request.request.contents,
          cachedContent: 'projects/test/locations/test/cachedContents/fixture',
        },
      });
    }
  });
  it.each(['conflict', 'creation-failure', 'cache-rejected', 'disabled'])(
    'sends the complete original body on %s',
    async (scenario) => {
      const request = body();
      if (scenario === 'conflict') {
        request.request.tool_config = { function_calling_config: { mode: 'NONE' } };
      }
      if (scenario === 'creation-failure') {
        rejectCreation = true;
      }
      if (scenario === 'cache-rejected') {
        rejectCachedGeneration = true;
      }
      if (scenario === 'disabled') {
        vi.stubEnv('PROXY_CONTEXT_CACHE_ENABLED', 'false');
      }
      await new GeminiClient(new Upstream4xxCaptureService()).generateInternal(
        request,
        'synthetic-not-a-credential',
      );
      expect(packets.at(-1)?.body).toEqual(request);
      expect(packets).toHaveLength(
        scenario === 'cache-rejected' ? 3 : scenario === 'creation-failure' ? 2 : 1,
      );
    },
  );
});
