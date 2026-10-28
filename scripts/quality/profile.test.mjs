import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyPaths, profileChecks, resolveProfile } from './profile.mjs';
import { selectChecks } from './checks.mjs';

test('only explicit documentation paths reduce checks; tooling, moves and unknown paths keep full checks', () => {
  assert.equal(classifyPaths(['docs/testing.md', 'CONTRIBUTING.md']), 'docs');
  for (const paths of [
    [],
    ['docs/fixture.ts'],
    ['.github/workflows/test.md'],
    ['.agents/skills/example/SKILL.md'],
    ['docs/testing.md', 'src/main.ts'],
    ['README.md', 'removed.ts'],
    ['unknown.txt'],
  ]) {
    assert.equal(classifyPaths(paths), 'full', JSON.stringify(paths));
  }
});

test('documentation profile retains governance and formatting but skips builds and application tests', () => {
  const checks = profileChecks(selectChecks('all'), 'docs');
  assert.equal(checks.find((check) => check.script === 'check:agent-contracts').skip, false);
  assert.equal(checks.find((check) => check.script === 'format').skip, false);
  assert.equal(checks.find((check) => check.script === 'test:unit').skip, true);
  assert.equal(checks.find((check) => check.script === 'package').skip, true);
  assert.equal(
    profileChecks(selectChecks('all'), 'full').some((check) => check.skip),
    false,
  );
  assert.throws(() => profileChecks([], 'typo'), /Unknown quality profile/);
});

test('unavailable or malformed PR metadata falls back to full coverage', () => {
  assert.equal(resolveProfile({}).profile, 'full');
  assert.equal(
    resolveProfile({
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: 'missing-event-file',
    }).profile,
    'full',
  );
});

test('real Git diff includes both sides of a code-to-documentation rename', (t) => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'agm profile '));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
  git('init');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  writeFileSync(path.join(cwd, 'code.ts'), 'export const value = 1;\n');
  git('add', 'code.ts');
  git('commit', '-m', 'fixture');
  const base = git('rev-parse', 'HEAD').trim();
  git('mv', 'code.ts', 'README.md');
  git('commit', '-m', 'move');
  const event = path.join(cwd, 'event.json');
  writeFileSync(
    event,
    JSON.stringify({
      pull_request: { base: { sha: base }, head: { sha: git('rev-parse', 'HEAD').trim() } },
    }),
  );
  assert.equal(
    resolveProfile(
      { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event },
      cwd,
    ).profile,
    'full',
  );
  const docBase = git('rev-parse', 'HEAD').trim();
  writeFileSync(path.join(cwd, 'README.md'), 'Documentation edit.\n');
  git('add', 'README.md');
  git('commit', '-m', 'docs');
  writeFileSync(
    event,
    JSON.stringify({
      pull_request: { base: { sha: docBase }, head: { sha: git('rev-parse', 'HEAD').trim() } },
    }),
  );
  assert.equal(
    resolveProfile(
      { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event },
      cwd,
    ).profile,
    'docs',
  );
});
