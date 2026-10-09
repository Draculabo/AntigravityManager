import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as Sentry from '@sentry/node';
import { z } from 'zod';
import {
  initializeCoreErrorReporting,
  flushErrorReporting,
} from '../../../src/core/error-reporting';
import { logger } from '../../../src/shared/logging/logger';

async function verifyTransport(): Promise<void> {
  const Event = z.object({
    message: z.string(),
    tags: z.object({
      runtime: z.literal('standalone-core'),
      isolated_diagnostic: z.literal('true'),
    }),
    user: z.object({ geo: z.object({}).strict() }).strict(),
  });
  let received = 0;
  let privacyPassed = false;
  const server = createServer((request, response) => {
    const buffers: Buffer[] = [];
    let bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) {
        request.destroy();
        return;
      }
      buffers.push(chunk);
    });
    request.on('end', () => {
      const lines = Buffer.concat(buffers).toString('utf8').split('\n');
      for (let index = 1; index < lines.length - 1; index += 2) {
        try {
          const header = z.object({ type: z.string() }).parse(JSON.parse(lines[index]));
          if (header.type !== 'event') {
            continue;
          }
          const raw: unknown = JSON.parse(lines[index + 1]);
          const event = Event.parse(raw);
          received++;
          privacyPassed =
            event.message === 'Controlled isolated Schema diagnostic' &&
            !JSON.stringify(raw).includes('controlled-private');
        } catch {
          privacyPassed = false;
        }
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Local transport could not listen');
  }
  const workspace = path.resolve('out/schema-work-package');
  await mkdir(workspace, { recursive: true });
  const directory = await mkdtemp(path.join(workspace, 'sentry-'));
  const preferencePath = path.join(directory, 'desktop-preferences.json');
  await writeFile(
    preferencePath,
    JSON.stringify({ preferences: { error_reporting_enabled: true, telemetry_enabled: false } }),
    { mode: 0o600 },
  );
  process.env.SENTRY_DSN = `http://controlled@127.0.0.1:${address.port}/1`;
  process.env.ANTIGRAVITY_DESKTOP_PREFERENCES_PATH = preferencePath;
  try {
    initializeCoreErrorReporting();
    Sentry.setUser({
      email: 'controlled-private@example.invalid',
      geo: { city: 'controlled-private' },
    });
    Sentry.setTag('account', 'controlled-private-account');
    Sentry.setContext('request', { schema: 'controlled-private-schema' });
    Sentry.addBreadcrumb({ message: 'controlled-private-breadcrumb' });
    logger.info('controlled-private-log');
    logger.diagnosticError('Controlled isolated Schema diagnostic');
    await flushErrorReporting();
    await Sentry.close(1000);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  process.stdout.write(
    `${JSON.stringify({ transport: 'real Node Sentry SDK to local receiver', eventsReceived: received, privacyPassed })}\n`,
  );
  if (received !== 1 || !privacyPassed) {
    process.exitCode = 1;
  }
}

void verifyTransport().catch(() => {
  process.stderr.write('Controlled Sentry transport verification failed.\n');
  process.exitCode = 1;
});
