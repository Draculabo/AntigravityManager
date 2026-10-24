import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import YAML from 'yaml';
import { CASES } from './cases.mjs';
import { gitText, prepare, score } from './run.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agm review evaluation '));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function fixture(t) {
  const directory = await temporary(t);
  const repository = path.join(directory, 'repository');
  await mkdir(path.join(repository, '.agents/skills/agm-code-review'), { recursive: true });
  await writeFile(
    path.join(repository, '.agents/skills/agm-code-review/SKILL.md'),
    'Review the supplied code.\n',
  );
  const git = (...args) =>
    execFileSync('git', ['-C', repository, ...args], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Review fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.hooksPath', path.join(directory, 'no-hooks'));
  git('config', 'commit.gpgsign', 'false');
  await writeFile(path.join(repository, 'source.js'), 'export const value = 0;\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'Initial fixture');
  const before = git('rev-parse', 'HEAD');
  await writeFile(path.join(repository, 'source.js'), 'export const value = 1;\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'Correct fixture');
  const fixed = git('rev-parse', 'HEAD');
  const pack = path.join(directory, 'pack');
  const entry = {
    id: 'fixture',
    before,
    fixed,
    paths: ['source.js'],
    task: 'Check the exported value.',
    rubric: 'The required value is one.',
    evidence: 'Synthetic test only.',
    preserve: 'Keep the export.',
  };
  await prepare(repository, pack, [entry]);
  const results = JSON.parse(await readFile(path.join(pack, 'results.template.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(pack, 'evaluator.json'), 'utf8'));
  results.run = {
    model: 'synthetic',
    instructionRevision: manifest.instructionDigest,
    tools: 'none',
    budget: 'fixture only',
    adjudicator: 'test fixture',
  };
  await writeFile(
    path.join(directory, 'response.md'),
    'Synthetic response, not a model evaluation.\n',
  );
  for (const sample of results.samples) {
    Object.assign(sample, {
      status: 'completed',
      response: 'response.md',
      durationMs: 5,
      tokens: null,
    });
  }
  const file = path.join(directory, 'results.json');
  const save = () => writeFile(file, JSON.stringify(results));
  await save();
  return { directory, repository, pack, results, manifest, file, save };
}

function finding(verdict) {
  return {
    id: 'R1',
    file: 'source.js',
    line: 1,
    trigger: 'Read value',
    impact: 'Wrong value',
    evidence: 'Source returns zero',
    proposal: 'Return one',
    verdict,
    reason: 'Synthetic adjudication',
  };
}

test('preparation separates answers, preserves the worktree and refuses overwrites', async (t) => {
  const f = await fixture(t);
  const status = gitText(f.repository, ['status', '--porcelain']);
  assert.equal(status, '');
  for (const sample of f.manifest.samples) {
    const task = await readFile(path.join(f.pack, 'reviewer', sample.id, 'task.md'), 'utf8');
    assert.doesNotMatch(task, /The required value is one|Correct fixture|Synthetic test only/);
  }
  await assert.rejects(
    prepare(f.repository, f.pack, [
      {
        id: 'fixture',
        before: f.manifest.samples.find((sample) => sample.variant === 'before').revision,
        fixed: f.manifest.samples.find((sample) => sample.variant === 'fixed').revision,
        paths: ['source.js'],
        task: 'Check the exported value.',
        rubric: 'The required value is one.',
        evidence: 'Synthetic test only.',
        preserve: 'Keep the export.',
      },
    ]),
    /EEXIST/,
  );
  await assert.rejects(
    prepare(f.repository, path.join(f.repository, 'output'), [
      {
        id: 'fixture',
        before: f.manifest.samples.find((sample) => sample.variant === 'before').revision,
        fixed: f.manifest.samples.find((sample) => sample.variant === 'fixed').revision,
        paths: ['source.js'],
        task: 'Check the exported value.',
        rubric: 'The required value is one.',
        evidence: 'Synthetic test only.',
        preserve: 'Keep the export.',
      },
    ]),
    /outside the repository/,
  );
  assert.equal(gitText(f.repository, ['status', '--porcelain']), status);
});

test('scores detection, false positives, harmful advice and unknown token usage without inventing a pass', async (t) => {
  const f = await fixture(t);
  for (const sample of f.results.samples) {
    const expected = f.manifest.samples.find((item) => item.id === sample.id);
    sample.findings =
      expected.variant === 'before'
        ? [finding('target-defect')]
        : [finding('harmful'), { ...finding('false-positive'), id: 'R2' }];
  }
  await f.save();
  const report = await score(f.pack, f.file);
  assert.deepEqual(
    {
      complete: report.complete,
      known: report.knownDefects,
      detected: report.detected,
      harmful: report.harmful,
      falsePositives: report.falsePositives,
      tokens: report.tokens,
    },
    { complete: true, known: 1, detected: 1, harmful: 1, falsePositives: 1, tokens: null },
  );
  const output = spawnSync(
    process.execPath,
    [runner, 'score', '--pack', f.pack, '--results', f.file],
    { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 },
  );
  assert.ifError(output.error);
  assert.equal(output.status, 0, output.stderr);
  assert.equal(JSON.parse(output.stdout).harmful, 1);
});

test('real CLI rejects incomplete, missing, duplicated, stale or invalid evidence', async (t) => {
  const f = await fixture(t);
  const original = structuredClone(f.results.samples);
  for (const mutate of [
    (samples) => {
      samples.pop();
    },
    (samples) => {
      samples[1] = structuredClone(samples[0]);
    },
    (samples) => {
      samples[0].response = '../outside.md';
    },
    (samples) => {
      samples[0].findings = [{ ...finding('false-positive'), line: 999 }];
    },
    (samples) => {
      samples[0].status = 'unavailable';
    },
    (samples) => {
      const fixed = f.manifest.samples.find((sample) => sample.variant === 'fixed');
      samples.find((sample) => sample.id === fixed.id).findings = [finding('target-defect')];
    },
  ]) {
    f.results.samples = structuredClone(original);
    mutate(f.results.samples);
    await f.save();
    const output = spawnSync(
      process.execPath,
      [runner, 'score', '--pack', f.pack, '--results', f.file],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 },
    );
    assert.ifError(output.error);
    assert.equal(output.status, 1, output.stdout);
  }
  f.results.samples = original;
  await f.save();
  await writeFile(path.join(f.pack, 'reviewer', original[0].id, 'source.js'), 'changed\n');
  await assert.rejects(score(f.pack, f.file), /Source input changed/);
});

test('historical AppImage registration probe rejects the defect and accepts the repair', () => {
  const entry = CASES.find((item) => item.id === 'appimage-pnpm-patch');
  const validate = (revision) => {
    const workspace = YAML.parse(gitText(root, ['show', `${revision}:pnpm-workspace.yaml`]));
    const lock = YAML.parse(gitText(root, ['show', `${revision}:pnpm-lock.yaml`]));
    const key = '@pengx17/electron-forge-maker-appimage@1.2.1';
    const patch = workspace.patchedDependencies[key];
    assert.equal(typeof patch, 'string', 'AppImage patch must be registered with pnpm');
    assert.equal(lock.patchedDependencies[key].path, patch);
    assert.ok(lock.patchedDependencies[key].hash);
    assert.match(gitText(root, ['show', `${revision}:${patch}`]), /appimage-extract-and-run/);
  };
  assert.throws(() => validate(entry.before), /AppImage patch must be registered/);
  validate(entry.fixed);
});

test('historical quota aggregation probe rejects both missing families and preserves correct controls', async () => {
  const entry = CASES.find((item) => item.id === 'quota-family-tiers');
  for (const variant of ['before', 'fixed']) {
    const source = gitText(root, [
      'show',
      `${entry[variant]}:src/modules/cloud-account/utils/quota-model-families.ts`,
    ]);
    const code = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
    );
    for (const [family, display] of [
      ['gemini-4-argon', 'Gemini 4 Argon'],
      ['gemini-3.8-flash', 'Gemini 3.8 Flash'],
    ]) {
      const quota = (percentage) => ({ percentage, resetTime: '2026-10-30T08:00:00.000Z' });
      const input = {
        [`${family}-low`]: quota(90),
        [`${family}-medium`]: quota(42),
        [`${family}-high`]: quota(12),
      };
      const expected = { [family]: { ...quota(12), display_name: display } };
      const check = () => {
        assert.deepEqual(module.aggregateQuotaModelFamilies(input), expected);
        assert.deepEqual(module.getVisibleQuotaModelsForPresentation(input, {}), expected);
      };
      if (variant === 'before') {
        assert.throws(check, assert.AssertionError);
      } else {
        check();
      }
    }
    const unknown = {
      'vendor-experimental-thinking-v9': { percentage: 23, resetTime: 'not-a-date' },
    };
    assert.deepEqual(module.aggregateQuotaModelFamilies(unknown), unknown);
  }
});
