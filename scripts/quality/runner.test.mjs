import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { selectChecks } from './checks.mjs';
import { runChecks } from './run.mjs';

const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));

async function fixture(t, checks, failingScript) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'agm quality '));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(
    path.join(cwd, 'package.json'),
    JSON.stringify({
      scripts: Object.fromEntries(
        checks.map((check) => [check.script, `node gate.mjs ${check.script}`]),
      ),
    }),
  );
  await writeFile(
    path.join(cwd, 'gate.mjs'),
    `import fs from 'node:fs'; fs.appendFileSync('observed.jsonl', JSON.stringify(process.argv.slice(2))+'\\n'); if(process.argv[2]===${JSON.stringify(failingScript ?? '')}) process.exit(7);`,
  );
  return cwd;
}

test('local static checks reuse CI checks and the complete selection contains each check once', () => {
  const all = selectChecks('all');
  const ci = ['tests', 'lint', 'format'].flatMap(selectChecks);
  assert.deepEqual(
    new Set(all.map((check) => check.script)),
    new Set(ci.map((check) => check.script)),
  );
  assert.equal(all.length, new Set(all.map((check) => check.script)).size);
  assert.deepEqual(
    selectChecks('static').map((check) => check.script),
    ['type-check', 'lint', 'format'],
  );
  assert.deepEqual(selectChecks('tests').find((check) => check.script === 'test:unit').args, [
    '--run',
  ]);
  assert.deepEqual(selectChecks('tests').find((check) => check.script === 'test:acceptance').args, [
    'unit',
  ]);
});

test('failed checks stop execution and leave later checks visibly not run', async (t) => {
  const checks = selectChecks('static');
  const cwd = await fixture(t, checks, 'lint');
  const results = runChecks(checks, cwd);
  assert.deepEqual(
    results.map(({ script, status }) => ({ script, status })),
    [
      { script: 'type-check', status: 'passed' },
      { script: 'lint', status: 'failed' },
      { script: 'format', status: 'not-run' },
    ],
  );
  assert.equal(results[1].exitCode, 7);
  assert.equal(
    await readFile(path.join(cwd, 'observed.jsonl'), 'utf8'),
    '["type-check"]\n["lint"]\n',
  );
});

test('pnpm arguments reach unit and acceptance commands without broadening the selected suite', async (t) => {
  const checks = selectChecks('tests').filter((check) =>
    ['test:unit', 'test:acceptance'].includes(check.script),
  );
  const cwd = await fixture(t, checks);
  assert.deepEqual(
    runChecks(checks, cwd).map(({ status }) => status),
    ['passed', 'passed'],
  );
  assert.equal(
    await readFile(path.join(cwd, 'observed.jsonl'), 'utf8'),
    '["test:unit","--run"]\n["test:acceptance","unit"]\n',
  );
});

test('CLI returns failure for a failed child and does not execute anything in list mode', async (t) => {
  const cwd = await fixture(t, selectChecks('static'), 'lint');
  const list = spawnSync(process.execPath, [runner, 'static', '--list'], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.ifError(list.error);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /pnpm run type-check/);
  const fullList = spawnSync(process.execPath, [runner, '--list'], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.ifError(fullList.error);
  assert.equal(fullList.status, 0, fullList.stderr);
  assert.match(fullList.stdout, /Additional entry points/);
  assert.match(fullList.stdout, /test:schema:live/);
  assert.equal(
    selectChecks('all').some((check) => check.script === 'test:schema:live'),
    false,
  );
  await assert.rejects(readFile(path.join(cwd, 'observed.jsonl')), { code: 'ENOENT' });
  const result = spawnSync(process.execPath, [runner, 'static'], {
    cwd,
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /"status": "not-run"/);
});

test('unknown selections fail before execution', () => {
  assert.throws(() => selectChecks('typo'), /Unknown check selection/);
  const result = spawnSync(process.execPath, [runner, 'typo'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Allowed choices/);
});
