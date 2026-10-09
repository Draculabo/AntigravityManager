import http from 'node:http';
import { Readable } from 'node:stream';
import { z } from 'zod';

const targets = {
  primary: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
  backup: 'https://cloudcode-pa.googleapis.com/v1internal',
};
const hopHeaders = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'accept-encoding',
  'content-encoding',
]);

/** Inject transport faults only for an armed controlled history; never retain private payloads. */
export async function createLiveRetryRelay({ forward = fetch } = {}) {
  let armed;
  const pending = new Set();
  const server = http.createServer((request, response) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_048_576) {
        request.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    request.on('end', () => {
      void (async () => {
        const controller = new AbortController();
        pending.add(controller);
        response.once('close', () => {
          if (!response.writableFinished) {
            controller.abort();
          }
        });
        try {
          const match =
            /^\/(primary|backup)\/v1internal(:(?:generateContent|streamGenerateContent))(\?alt=sse)?$/.exec(
              request.url ?? '',
            );
          if (request.method !== 'POST' || !match) {
            response.writeHead(400).end();
            return;
          }
          const role = match[1];
          const bytes = Buffer.concat(chunks);
          let observation;
          if (armed && bytes.includes(armed.marker)) {
            if (armed.observations.length >= 32) {
              throw new Error('Controlled retry observations exceeded their bound');
            }
            const authorization = request.headers.authorization;
            if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
              throw new Error('Controlled upstream authorization is missing');
            }
            if (!armed.identities.has(authorization)) {
              armed.identities.set(authorization, armed.identities.size + 1);
            }
            const parsed = z
              .object({ request: z.object({ contents: z.array(z.unknown()) }) })
              .parse(JSON.parse(bytes.toString('utf8')));
            const contents = JSON.stringify(parsed.request.contents);
            armed.contents ??= contents;
            observation = {
              role,
              transportIdentityOrdinal: armed.identities.get(authorization),
              contentsUnchanged: contents === armed.contents,
              action: 'forwarded',
            };
            armed.observations.push(observation);
            if (
              armed.mode === 'incomplete' &&
              armed.observations.length === 1 &&
              match[2] === ':generateContent'
            ) {
              observation.action = 'injected-incomplete-thinking';
              response.writeHead(200, { 'content-type': 'application/json' });
              response.end(
                JSON.stringify({
                  response: {
                    candidates: [
                      {
                        content: {
                          role: 'model',
                          parts: [
                            { thought: true, text: 'Controlled incomplete reasoning fragment' },
                          ],
                        },
                      },
                    ],
                  },
                }),
              );
              return;
            }
            if (armed.mode === 'network' && armed.observations.length === 1 && role === 'primary') {
              observation.action = 'socket-reset';
              response.destroy();
              return;
            }
            if (armed.mode === 'rotation' && observation.transportIdentityOrdinal === 1) {
              observation.action = 'injected-503';
              response.writeHead(503, { 'content-type': 'application/json' });
              response.end(
                JSON.stringify({
                  error: {
                    code: 503,
                    status: 'UNAVAILABLE',
                    message: 'Controlled acceptance transport unavailable',
                  },
                }),
              );
              return;
            }
          }
          const headers = new Headers();
          for (const [name, value] of Object.entries(request.headers)) {
            if (!hopHeaders.has(name) && typeof value === 'string') {
              headers.set(name, value);
            }
          }
          const upstream = await forward(`${targets[role]}${match[2]}${match[3] ?? ''}`, {
            method: 'POST',
            headers,
            body: bytes,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
          });
          if (observation) {
            observation.status = upstream.status;
          }
          for (const [name, value] of upstream.headers) {
            if (!hopHeaders.has(name)) {
              response.setHeader(name, value);
            }
          }
          response.writeHead(upstream.status);
          if (upstream.body) {
            const stream = Readable.fromWeb(upstream.body);
            stream.once('error', () => response.destroy());
            response.once('close', () => stream.destroy());
            stream.pipe(response);
          } else {
            response.end();
          }
        } catch {
          if (!response.headersSent) {
            response.writeHead(502, { 'content-type': 'application/json' });
            response.end('{"error":{"message":"Controlled relay forwarding failed"}}');
          } else {
            response.destroy();
          }
        } finally {
          pending.delete(controller);
        }
      })();
    });
    request.once('error', () => response.destroy());
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Controlled relay address is unavailable');
  }
  const base = `http://127.0.0.1:${address.port}`;
  return {
    baseUrls: `${base}/primary/v1internal,${base}/backup/v1internal`,
    arm(mode, marker) {
      if (armed || !['network', 'rotation', 'incomplete'].includes(mode) || !marker) {
        throw new Error('Controlled relay cannot arm this scenario');
      }
      armed = { mode, marker, identities: new Map(), observations: [] };
    },
    disarm() {
      const observations = armed?.observations ?? [];
      armed?.identities.clear();
      armed = undefined;
      return observations;
    },
    async close() {
      armed?.identities.clear();
      armed = undefined;
      for (const controller of pending) {
        controller.abort();
      }
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
  };
}
