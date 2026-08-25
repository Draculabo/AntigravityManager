import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { collectChangeScope } from './change-scope.mjs';

function runGit(rootDir, args) {
  const result = spawnSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function createRepositoryFixture() {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agm-change-scope-'));

  runGit(rootDir, ['init']);
  runGit(rootDir, ['config', 'user.name', 'Agent Test']);
  runGit(rootDir, ['config', 'user.email', 'agent-test@example.com']);

  await Promise.all([
    writeFile(path.join(rootDir, 'staged.txt'), 'initial\n', 'utf8'),
    writeFile(path.join(rootDir, 'unstaged.txt'), 'initial\n', 'utf8'),
  ]);
  runGit(rootDir, ['add', '.']);
  runGit(rootDir, ['commit', '-m', 'initial']);
  const base = runGit(rootDir, ['rev-parse', 'HEAD']);

  await writeFile(path.join(rootDir, 'committed.txt'), 'committed\n', 'utf8');
  runGit(rootDir, ['add', 'committed.txt']);
  runGit(rootDir, ['commit', '-m', 'committed change']);
  await writeFile(path.join(rootDir, 'staged.txt'), 'staged\n', 'utf8');
  runGit(rootDir, ['add', 'staged.txt']);
  await writeFile(path.join(rootDir, 'unstaged.txt'), 'unstaged\n', 'utf8');
  await writeFile(path.join(rootDir, 'new file.txt'), 'untracked\n', 'utf8');

  return { base, rootDir };
}

test('reports committed, staged, unstaged and untracked paths separately', async (context) => {
  const { base, rootDir } = await createRepositoryFixture();
  context.after(async () => rm(rootDir, { recursive: true, force: true }));

  const report = collectChangeScope(rootDir, { base, head: 'HEAD' });

  assert.deepEqual(report.paths, {
    committed: ['committed.txt'],
    staged: ['staged.txt'],
    unstaged: ['unstaged.txt'],
    untracked: ['new file.txt'],
  });
  assert.deepEqual(report.changedPaths, [
    'committed.txt',
    'new file.txt',
    'staged.txt',
    'unstaged.txt',
  ]);
});

test('preserves paths with spaces and does not modify the worktree', async (context) => {
  const { base, rootDir } = await createRepositoryFixture();
  context.after(async () => rm(rootDir, { recursive: true, force: true }));
  await writeFile(path.join(rootDir, 'staged file.txt'), 'staged\n', 'utf8');
  runGit(rootDir, ['add', 'staged file.txt']);
  const statusBefore = runGit(rootDir, ['status', '--porcelain=v1', '-z']);

  const report = collectChangeScope(rootDir, { base, head: 'HEAD' });

  assert.deepEqual(report.paths.staged, ['staged file.txt', 'staged.txt']);
  assert.equal(runGit(rootDir, ['status', '--porcelain=v1', '-z']), statusBefore);
});

test('rejects a revision that is not a commit', async (context) => {
  const { rootDir } = await createRepositoryFixture();
  context.after(async () => rm(rootDir, { recursive: true, force: true }));

  assert.throws(
    () => collectChangeScope(rootDir, { base: 'does-not-exist', head: 'HEAD' }),
    /Unable to resolve base revision "does-not-exist"/,
  );
});

test('requires callers to select an explicit base revision', async (context) => {
  const { rootDir } = await createRepositoryFixture();
  context.after(async () => rm(rootDir, { recursive: true, force: true }));

  assert.throws(() => collectChangeScope(rootDir, { head: 'HEAD' }), /base revision is required/);
});

test('rejects an ambiguous base revision', async (context) => {
  const { base, rootDir } = await createRepositoryFixture();
  context.after(async () => rm(rootDir, { recursive: true, force: true }));
  runGit(rootDir, ['branch', 'collision', base]);
  runGit(rootDir, ['tag', 'collision', 'HEAD']);

  assert.throws(
    () => collectChangeScope(rootDir, { base: 'collision', head: 'HEAD' }),
    /base revision "collision" is ambiguous/,
  );
});

test('rejects revisions without a merge base', async (context) => {
  const { base, rootDir } = await createRepositoryFixture();
  context.after(async () => rm(rootDir, { recursive: true, force: true }));
  runGit(rootDir, ['checkout', '--orphan', 'isolated']);
  runGit(rootDir, ['rm', '-rf', '.']);
  await writeFile(path.join(rootDir, 'isolated.txt'), 'isolated\n', 'utf8');
  runGit(rootDir, ['add', 'isolated.txt']);
  runGit(rootDir, ['commit', '-m', 'isolated']);

  assert.throws(
    () => collectChangeScope(rootDir, { base, head: 'HEAD' }),
    /git merge-base .* failed: exit code 1/,
  );
});
