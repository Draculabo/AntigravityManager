import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Retain only strict public diagnostics and schema issue locations from local test logs. */
export async function readPackagedCliDiagnostic({ home, directory, output, fixture }) {
  const log = await readFile(
    path.join(home, '.antigravity-agent', 'core-' + new Date().toISOString().slice(0, 10) + '.log'),
    'utf8',
  ).catch(() => '');
  const appLog = await readFile(
    path.join(home, '.antigravity-agent', 'app-' + new Date().toISOString().slice(0, 10) + '.log'),
    'utf8',
  ).catch(() => '');
  const records = [log, appLog, output].join('\n');
  const matches = [...records.matchAll(/Operation diagnostic v1 (\{[^\r\n]+\})/g)];
  const invalidDiagnostics = matches.flatMap((record) => {
    const parsed = fixture.OperationDiagnosticSchema.safeParse(JSON.parse(record[1]));
    return parsed.success
      ? []
      : parsed.error.issues.map((issue) => ({ code: issue.code, path: issue.path }));
  });
  const candidates = matches
    .map((record) =>
      fixture.readFinalizedOperationDiagnostic({ diagnostic: JSON.parse(record[1]) }),
    )
    .filter(Boolean);
  await writeFile(
    path.join(directory, 'cli-exchange-evidence.json'),
    JSON.stringify(
      {
        candidates,
        invalidDiagnostics,
        structuredRecords: matches.length,
        sourceBytes: {
          core: Buffer.byteLength(log),
          app: Buffer.byteLength(appLog),
          terminal: Buffer.byteLength(output),
        },
        observed: {
          operationMarker: records.includes('Operation diagnostic v1'),
          tokenExchange: records.includes('token-exchange'),
          connectRoute: records.includes('https-connect'),
        },
      },
      null,
      2,
    ),
  );
  assert.deepEqual(invalidDiagnostics, [], 'Structured operation logs must remain valid');
  return candidates.find((candidate) => candidate.stage === 'token-exchange');
}
