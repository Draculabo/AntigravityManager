import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';
import { ADDITIONAL_CHECKS, CHECKS, CI_LANES } from './checks.mjs';
import { validateQualityContracts } from './contracts.mjs';

const validator = fileURLToPath(new URL('./contracts.mjs', import.meta.url));
const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));

async function write(cwd, file, content) {
  await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
  await writeFile(path.join(cwd, file), content);
}

async function fixture(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'agm quality contracts '));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const scripts = Object.fromEntries(CHECKS.map((check) => [check.script, 'node fixture.mjs']));
  for (const script of Object.keys(ADDITIONAL_CHECKS)) {
    scripts[script] = 'node fixture.mjs';
  }
  Object.assign(scripts, {
    'check:ci': 'node scripts/quality/run.mjs',
    'check:governance': 'node scripts/quality/run.mjs governance',
    'check:static': 'node scripts/quality/run.mjs static',
    'check:quality': 'node scripts/quality/contracts.mjs',
  });
  await write(cwd, 'package.json', JSON.stringify({ scripts }));
  await write(cwd, 'scripts/README.md', 'Run `pnpm run check:ci --list`.\n');
  await write(
    cwd,
    'scripts/quality/contracts.mjs',
    `import {spawnSync} from 'node:child_process'; const r=spawnSync(process.execPath,[${JSON.stringify(validator)},process.cwd()],{stdio:'inherit'}); process.exitCode=r.status??1;\n`,
  );
  for (const [name, lane] of Object.entries(CI_LANES)) {
    await write(
      cwd,
      lane.workflow,
      YAML.stringify({
        jobs: {
          [lane.job]: {
            'runs-on': lane.platforms.length > 1 ? '${{ matrix.os }}' : lane.platforms[0],
            ...(lane.platforms.length > 1 ? { strategy: { matrix: { os: lane.platforms } } } : {}),
            steps: [
              { uses: 'pnpm/action-setup@v4', with: { run_install: false } },
              { uses: 'actions/setup-node@v4', with: { 'node-version-file': '.nvmrc' } },
              { run: 'pnpm install --frozen-lockfile' },
              { run: `pnpm run check:ci ${name}` },
            ],
          },
        },
      }),
    );
  }
  return cwd;
}

async function mutateWorkflow(cwd, update) {
  const file = CI_LANES.tests.workflow;
  const workflow = YAML.parse(await readFile(path.join(cwd, file), 'utf8'));
  update(workflow.jobs[CI_LANES.tests.job]);
  await write(cwd, file, YAML.stringify(workflow));
}

test('accepts all CI lanes using the shared registry', async (t) => {
  assert.deepEqual(validateQualityContracts(await fixture(t)), []);
});

test('real validator rejects a workflow that loses the shared test command', async (t) => {
  const cwd = await fixture(t);
  await mutateWorkflow(cwd, (job) => {
    job.steps = [{ run: 'pnpm run test:unit --run' }];
  });
  const result = spawnSync(process.execPath, [validator, cwd], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must execute exactly once: pnpm run check:ci tests/);
});

test('another CI lane blocks missing test wiring before its own check starts', async (t) => {
  const cwd = await fixture(t);
  await mutateWorkflow(cwd, (job) => {
    job.steps = [];
  });
  const result = spawnSync(process.execPath, [runner, 'lint'], {
    cwd,
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must execute exactly once/);
  assert.match(result.stdout, /"script": "lint",\s+"status": "not-run"/);
});

for (const bypass of [
  'conditional-step',
  'conditional-job',
  'ignored-step',
  'ignored-job',
  'masked-command',
]) {
  test(`rejects required checks bypassed by ${bypass}`, async (t) => {
    const cwd = await fixture(t);
    await mutateWorkflow(cwd, (job) => {
      if (bypass === 'conditional-step') {
        job.steps.at(-1).if = 'false';
      }
      if (bypass === 'conditional-job') {
        job.if = 'false';
      }
      if (bypass === 'ignored-step') {
        job.steps.at(-1)['continue-on-error'] = true;
      }
      if (bypass === 'ignored-job') {
        job['continue-on-error'] = true;
      }
      if (bypass === 'masked-command') {
        job.steps.at(-1).run += ' || true';
      }
    });
    assert.notEqual(validateQualityContracts(cwd).length, 0);
  });
}

test('rejects dropping Windows from the actual CI matrix', async (t) => {
  const cwd = await fixture(t);
  await mutateWorkflow(cwd, (job) => {
    job.strategy.matrix.os = ['ubuntu-latest'];
  });
  assert.deepEqual(validateQualityContracts(cwd), [
    '.github/workflows/testing.yaml: tests-unit must cover ubuntu-latest, windows-latest.',
  ]);
});

test('rejects missing registered pnpm commands and an independently maintained aggregate', async (t) => {
  const cwd = await fixture(t);
  const pkg = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8'));
  delete pkg.scripts['test:git-hooks'];
  pkg.scripts['check:ci'] = 'pnpm test';
  await write(cwd, 'package.json', JSON.stringify(pkg));
  assert.deepEqual(validateQualityContracts(cwd), [
    'Registered check references missing pnpm script: test:git-hooks',
    'check:ci must use the shared quality runner.',
  ]);
});

test('rejects a script guide that no longer exposes the current check inventory', async (t) => {
  const cwd = await fixture(t);
  await write(cwd, 'scripts/README.md', '# Scripts\n');
  assert.deepEqual(validateQualityContracts(cwd), [
    'scripts/README.md must link to the executable check inventory.',
  ]);
});

test('rejects a successful no-op substituted for the shared contract command', async (t) => {
  const cwd = await fixture(t);
  const pkg = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8'));
  pkg.scripts['check:quality'] = 'node -e "process.exit(0)"';
  await write(cwd, 'package.json', JSON.stringify(pkg));
  assert.deepEqual(validateQualityContracts(cwd), [
    'check:quality must execute the quality contract validator.',
  ]);
});

test('rejects a new verification command without CI registration or an additional-entry explanation', async (t) => {
  const cwd = await fixture(t);
  const pkg = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8'));
  pkg.scripts['test:forgotten'] = 'node future-test.mjs';
  await write(cwd, 'package.json', JSON.stringify(pkg));
  assert.deepEqual(validateQualityContracts(cwd), [
    'Unclassified verification command: test:forgotten. Register a CI check or explain its additional entry point.',
  ]);
});

test('rejects CI installs that bypass the pinned toolchain or frozen lockfile', async (t) => {
  for (const scenario of ['node', 'pnpm', 'lock']) {
    const cwd = await fixture(t);
    await mutateWorkflow(cwd, (job) => {
      if (scenario === 'node') {
        job.steps[1].with = { 'node-version': 22 };
      } else if (scenario === 'pnpm') {
        job.steps.splice(0, 1);
      } else {
        job.steps[2].run = 'pnpm install --no-frozen-lockfile';
      }
    });
    assert(
      validateQualityContracts(cwd).some((error) => error.includes('use pinned pnpm and Node')),
    );
  }
});
