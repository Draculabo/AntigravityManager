import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadEnv } from 'vite';
import { z } from 'zod';
import { format } from 'prettier';

const eventId = z
  .string()
  .regex(/^[a-f0-9]{32}$/)
  .parse(process.argv[2]);
const expectedRelease = z
  .string()
  .regex(/^schema-live-\d{4}-\d{2}-\d{2}-[a-f0-9]{8}$/)
  .parse(process.argv[3]);
const development = loadEnv('development', process.cwd(), '');
const production = loadEnv('production', process.cwd(), '');
const environment = { ...process.env };
for (const name of ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT', 'SENTRY_BASE_URL']) {
  const value = process.env[name] || development[name] || production[name];
  if (value) {
    environment[name] = value;
  } else {
    delete environment[name];
  }
}
const python = path.join(
  os.homedir(),
  '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe',
);
const script = path.join(os.homedir(), '.codex/skills/sentry/scripts/sentry_api.py');
// The helper redacts even null email/IP fields. Inspect presence in memory, then emit only booleans.
const queried = spawnSync(
  python,
  [script, '--no-redact', 'event-detail', eventId, '--include-entries'],
  { env: environment, windowsHide: true, encoding: 'utf8', timeout: 30_000, maxBuffer: 1_048_576 },
);
if (queried.status !== 0) {
  process.stderr.write('Remote event query could not complete.\n');
  process.exitCode = 1;
} else {
  const Entry = z.object({ type: z.string(), data: z.unknown() });
  const Event = z
    .object({
      tags: z.array(z.object({ key: z.string(), value: z.string() })),
      entries: z.array(Entry),
      user: z.unknown().optional(),
      contexts: z.unknown().optional(),
      dateCreated: z.string().optional(),
      metadata: z.object({ value: z.string().optional() }).passthrough().optional(),
    })
    .passthrough();
  const event = Event.parse(JSON.parse(queried.stdout));
  const messageEntry = event.entries.find((entry) => entry.type === 'message');
  const message = z
    .object({ formatted: z.string().optional(), message: z.string().optional() })
    .safeParse(messageEntry?.data);
  const text = message.success
    ? (message.data.formatted ?? message.data.message ?? event.metadata?.value ?? '')
    : (event.metadata?.value ?? '');
  const diagnosticText = text.startsWith('Schema conversion issue ')
    ? text.slice('Schema conversion issue '.length)
    : '';
  let diagnostic;
  try {
    diagnostic = z
      .object({
        protocol: z.string(),
        degraded: z.boolean(),
        issueCount: z.number(),
        issues: z.array(
          z.object({
            kind: z.string(),
            recovered: z.boolean(),
            toolOrdinal: z.number().nullable(),
          }),
        ),
      })
      .parse(JSON.parse(diagnosticText));
  } catch {
    diagnostic = undefined;
  }
  const tag = (key) => event.tags.find((item) => item.key === key)?.value;
  function nonempty(value, depth = 0) {
    if (value === null || value === undefined || value === '') {
      return false;
    }
    if (depth > 16) {
      return true;
    }
    if (Array.isArray(value)) {
      return value.some((item) => nonempty(item, depth + 1));
    }
    if (typeof value === 'object') {
      return Object.values(value).some((item) => nonempty(item, depth + 1));
    }
    return true;
  }
  const user = z.record(z.string(), z.unknown()).safeParse(event.user);
  const userContextPresent = user.success && nonempty(user.data);
  const unsafeEntries = event.entries
    .filter((entry) => ['request', 'breadcrumbs', 'exception'].includes(entry.type))
    .some((entry) => {
      const data = z.record(z.string(), z.unknown()).safeParse(entry.data);
      return data.success && nonempty(data.data);
    });
  const verified =
    tag('release') === expectedRelease &&
    tag('runtime') === 'standalone-core' &&
    tag('isolated_diagnostic') === 'true' &&
    Boolean(diagnostic) &&
    !userContextPresent &&
    !unsafeEntries &&
    !/probe_read|invalid\.example|file_path|Bearer|access_token/i.test(text);
  const userFieldPresence = Object.fromEntries(
    ['id', 'email', 'username', 'name', 'ip_address', 'geo', 'data'].map((key) => [
      key,
      user.success && nonempty(user.data[key]),
    ]),
  );
  const summary = {
    eventId,
    expectedRelease,
    releaseMatched: tag('release') === expectedRelease,
    runtimeMatched: tag('runtime') === 'standalone-core',
    isolatedDiagnostic: tag('isolated_diagnostic') === 'true',
    diagnostic: diagnostic
      ? {
          protocol: diagnostic.protocol,
          degraded: diagnostic.degraded,
          issueCount: diagnostic.issueCount,
          kinds: diagnostic.issues.map((issue) => issue.kind),
          recovered: diagnostic.issues.map((issue) => issue.recovered),
        }
      : undefined,
    userContextPresent,
    userFieldPresence,
    unsafeEntries,
    privacyVerified: verified,
    receivedAt: event.dateCreated,
  };
  fs.writeFileSync(
    path.resolve('artifacts/schema-work-package/remote-event-verification.json'),
    await format(JSON.stringify(summary), { parser: 'json' }),
  );
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (!verified) {
    process.exitCode = 1;
  }
}
