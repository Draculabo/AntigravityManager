import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';

/** Observe field presence after the real SDK's beforeSend, then forward to the configured service. */
export async function createRemoteSentryRelay(originalDsn) {
  const dsn = new URL(originalDsn);
  if (dsn.protocol !== 'https:' || !dsn.hostname.endsWith('.sentry.io')) {
    throw new Error('Remote Sentry relay requires the configured HTTPS Sentry host');
  }
  const project = dsn.pathname.split('/').filter(Boolean).at(-1);
  if (!project || !/^\d+$/.test(project)) {
    throw new Error('Sentry project identifier is invalid');
  }
  const prefix = dsn.pathname.slice(0, dsn.pathname.lastIndexOf('/'));
  const target = new URL(`${prefix}/api/${project}/envelope/`, dsn.origin);
  target.searchParams.set('sentry_key', dsn.username);
  target.searchParams.set('sentry_version', '7');
  const observations = [];
  const pending = new Set();
  const server = createServer((request, response) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_048_576) {
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const forwarding = (async () => {
        const forwardedEvents = [];
        try {
          const encoded = Buffer.concat(chunks);
          const bytes =
            request.headers['content-encoding'] === 'gzip'
              ? gunzipSync(encoded, { maxOutputLength: 1_048_576 })
              : encoded;
          const lines = bytes.toString('utf8').split('\n');
          const header = z.record(z.string(), z.unknown()).parse(JSON.parse(lines[0]));
          header.dsn = originalDsn;
          lines[0] = JSON.stringify(header);
          for (let index = 1; index < lines.length - 1; index += 2) {
            const item = z.object({ type: z.string() }).parse(JSON.parse(lines[index]));
            if (item.type !== 'event') {
              continue;
            }
            const event = z
              .object({
                event_id: z.string(),
                message: z.string().optional(),
                user: z.unknown().optional(),
                request: z.unknown().optional(),
                breadcrumbs: z.unknown().optional(),
                contexts: z.unknown().optional(),
                extra: z.unknown().optional(),
              })
              .parse(JSON.parse(lines[index + 1]));
            if (event.message?.startsWith('Schema conversion issue ')) {
              const observation = {
                eventId: event.event_id,
                userPresent: event.user !== undefined,
                emptyGeoOverride: z
                  .object({ geo: z.object({}).strict() })
                  .strict()
                  .safeParse(event.user).success,
                requestPresent: event.request !== undefined,
                breadcrumbsPresent: event.breadcrumbs !== undefined,
                contextsPresent: event.contexts !== undefined,
                extraPresent: event.extra !== undefined,
              };
              observations.push(observation);
              forwardedEvents.push(observation);
            }
          }
          const upstream = await fetch(target, {
            method: 'POST',
            headers: { 'content-type': 'application/x-sentry-envelope' },
            body: lines.join('\n'),
            signal: AbortSignal.timeout(10_000),
          });
          for (const observation of forwardedEvents) {
            observation.transportStatus = upstream.status;
          }
          response.writeHead(upstream.status).end();
        } catch {
          for (const observation of forwardedEvents) {
            observation.transportFailed = true;
          }
          response.writeHead(502).end();
        }
      })();
      pending.add(forwarding);
      void forwarding.finally(() => pending.delete(forwarding));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Sentry observation relay could not listen');
  }
  const localDsn = new URL(`http://127.0.0.1:${address.port}/${project}`);
  localDsn.username = dsn.username;
  return {
    dsn: localDsn.toString(),
    observations,
    async close() {
      await Promise.allSettled([...pending]);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
