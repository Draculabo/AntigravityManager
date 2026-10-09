import { createServer } from 'node:http';
import {
  clientSchemaMetrics,
  requestToolResultMatches,
  responseToolCalls,
  toolCallsAreReadOnly,
} from './multi-client-protocol.mjs';

const excluded = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'accept-encoding',
  'content-encoding',
  'authorization',
  'x-api-key',
]);
const routes = new Map([
  ['/v1/responses', 'responses'],
  ['/v1/chat/completions', 'chat'],
  ['/v1/messages', 'messages'],
]);

export async function createMultiClientRelay({
  gateway,
  apiKey,
  client,
  trace,
  directory,
  marker,
  measureSchemas,
  forward = fetch,
}) {
  const observations = [];
  const controllers = new Set();
  const server = createServer((request, response) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2_097_152) {
        request.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    request.once('error', () => response.destroy());
    request.on('end', () => {
      void (async () => {
        const controller = new AbortController();
        controllers.add(controller);
        response.once('close', () => {
          if (!response.writableFinished) {
            controller.abort();
          }
        });
        let observation;
        try {
          const route = new URL(request.url ?? '/', gateway).pathname;
          const protocol = routes.get(route);
          if (
            !(
              (request.method === 'POST' && protocol) ||
              (request.method === 'GET' && route === '/v1/models')
            )
          ) {
            response.writeHead(404).end();
            return;
          }
          if (observations.length >= 12) {
            throw new Error('Client requests exceeded their bound');
          }
          const bytes = Buffer.concat(chunks);
          if (protocol) {
            const body = JSON.parse(bytes.toString('utf8'));
            observation = {
              protocol,
              schemas: clientSchemaMetrics(body, measureSchemas),
              toolResultMatched: requestToolResultMatches(body, marker),
              toolCalls: 0,
              safeTools: false,
            };
            observations.push(observation);
          }
          const headers = new Headers();
          for (const [name, value] of Object.entries(request.headers)) {
            if (!excluded.has(name) && typeof value === 'string') {
              headers.set(name, value);
            }
          }
          headers.set('x-schema-acceptance', `${trace}:multi-client:${client}`);
          if (apiKey) {
            headers.set('authorization', `Bearer ${apiKey}`);
            headers.set('x-api-key', apiKey);
          }
          const upstream = await forward(new URL(route, gateway), {
            method: request.method,
            headers,
            ...(request.method === 'POST' ? { body: bytes } : {}),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
          });
          if (observation) {
            observation.status = upstream.status;
          }
          const bodyChunks = [];
          let received = 0;
          for await (const chunk of upstream.body ?? []) {
            received += chunk.length;
            if (received > 2_097_152) {
              throw new Error('Client response exceeded its bound');
            }
            bodyChunks.push(Buffer.from(chunk));
          }
          const body = Buffer.concat(bodyChunks);
          if (observation) {
            const calls = responseToolCalls(body.toString('utf8'));
            observation.toolCalls = calls.length;
            observation.safeTools = toolCallsAreReadOnly(calls, directory);
            if (!observation.safeTools) {
              observation.blockedToolInstructions = true;
              response
                .writeHead(502, { 'content-type': 'application/json' })
                .end(
                  '{"error":{"message":"Controlled client tool instruction is outside the read-only allowlist"}}',
                );
              return;
            }
          }
          for (const [name, value] of upstream.headers) {
            if (!excluded.has(name)) {
              response.setHeader(name, value);
            }
          }
          response.writeHead(upstream.status).end(body);
        } catch {
          if (observation) {
            observation.relayFailure = true;
          }
          if (!response.headersSent) {
            response
              .writeHead(502, { 'content-type': 'application/json' })
              .end('{"error":{"message":"Controlled client forwarding failed"}}');
          } else {
            response.destroy();
          }
        } finally {
          controllers.delete(controller);
        }
      })();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Client relay address is unavailable');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    observations,
    async close() {
      for (const controller of controllers) {
        controller.abort();
      }
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
  };
}
