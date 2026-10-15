import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const installer = path.join(root, 'scripts/git/install-hooks.mjs');
const lefthook = path.join(root, 'scripts/git/run-lefthook.mjs');
const selector = path.join(root, 'scripts/git/check-staged-governance.mjs');
const previousHook = path.join(root, 'scripts/git/run-previous-pre-commit.mjs');
const quote = (value) => JSON.stringify(value.replaceAll('\\', '/'));

function run(cwd, command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      CI: '',
      NODE_ENV: '',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      ...extraEnv,
    },
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 64 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, `child ended with ${result.signal}`);
  return result;
}

function git(cwd, ...args) {
  const result = run(cwd, 'git', args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function fixture(context) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'agm hooks-'));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const cwd = path.join(temporary, 'checkout with spaces');
  await mkdir(cwd);
  git(cwd, 'init', '--quiet');
  git(cwd, 'config', 'user.name', 'Hook fixture');
  git(cwd, 'config', 'user.email', 'hooks@example.invalid');
  git(cwd, 'config', 'core.autocrlf', 'false');
  const configuration = (await readFile(path.join(root, 'lefthook.yml'), 'utf8'))
    .replace('node scripts/git/run-lefthook.mjs', `node ${quote(lefthook)}`)
    .replace('node scripts/git/check-staged-governance.mjs', `node ${quote(selector)}`)
    .replace('node scripts/git/run-previous-pre-commit.mjs', `node ${quote(previousHook)}`);
  await writeFile(path.join(cwd, 'lefthook.yml'), configuration);
  await writeFile(
    path.join(cwd, 'package.json'),
    JSON.stringify({
      scripts: {
        'check:agent-contracts': 'node gate.mjs governance',
        'type-check': 'node gate.mjs types',
      },
    }),
  );
  await writeFile(
    path.join(cwd, 'gate.mjs'),
    "import {existsSync,appendFileSync} from 'node:fs'; const gate=process.argv[2]; appendFileSync('observed.log',gate+'\\n'); if(existsSync(gate+'.fail')) { console.error(gate+' fixture failure'); process.exit(1); }\n",
  );
  return { cwd, temporary };
}

function install(cwd, env) {
  return run(cwd, process.execPath, [installer], env);
}

async function seed(cwd) {
  await writeFile(path.join(cwd, 'code.txt'), 'initial\n');
  git(cwd, 'add', '--', 'code.txt');
  git(cwd, 'commit', '--quiet', '-m', 'fixture seed');
}

test('installed commit hook skips unrelated governance and preserves the previous hook', async (context) => {
  const { cwd } = await fixture(context);
  const hookPath = path.join(cwd, '.git/hooks/pre-commit');
  const previous = '#!/bin/sh\nprintf "previous\\n" >> observed.log\n';
  await writeFile(hookPath, previous, { mode: 0o755 });
  await writeFile(path.join(cwd, 'governance.fail'), '');
  await writeFile(path.join(cwd, 'code.txt'), 'valid\n');
  git(cwd, 'add', '--', 'code.txt');
  const index = git(cwd, 'ls-files', '--stage');

  assert.equal(install(cwd).status, 0);
  assert.equal(install(cwd).status, 0);
  assert.equal(git(cwd, 'ls-files', '--stage'), index);
  assert.equal(await readFile(`${hookPath}.old`, 'utf8'), previous);
  git(cwd, 'commit', '--quiet', '-m', 'fixture valid commit');
  assert.equal(await readFile(path.join(cwd, 'observed.log'), 'utf8'), 'previous\n');
  assert.equal(run(cwd, process.execPath, [lefthook, 'uninstall']).status, 0);
  assert.equal(await readFile(hookPath, 'utf8'), previous);
});

test('installed hook rejects staged whitespace even if the worktree is clean', async (context) => {
  const { cwd } = await fixture(context);
  await writeFile(path.join(cwd, 'code.txt'), 'bad trailing whitespace \n');
  git(cwd, 'add', '--', 'code.txt');
  await writeFile(path.join(cwd, 'code.txt'), 'clean worktree\n');
  assert.equal(install(cwd).status, 0);

  const commit = run(cwd, 'git', ['commit', '--quiet', '-m', 'fixture whitespace']);
  assert.notEqual(commit.status, 0);
  assert.match(commit.stdout + commit.stderr, /trailing whitespace/);
  assert.notEqual(run(cwd, 'git', ['rev-parse', '--verify', 'HEAD']).status, 0);
  assert.match(git(cwd, 'show', ':code.txt'), /bad trailing whitespace/);
  assert.equal(await readFile(path.join(cwd, 'code.txt'), 'utf8'), 'clean worktree\n');
  assert.equal(git(cwd, 'stash', 'list'), '');
});

for (const change of ['add', 'delete', 'rename']) {
  test(`installed hook selects governance ${change} paths and blocks failed contracts`, async (context) => {
    const { cwd } = await fixture(context);
    if (change !== 'add') {
      await writeFile(path.join(cwd, 'AGENTS.md'), '# Fixture\n');
      git(cwd, 'add', '--', 'AGENTS.md');
      git(cwd, 'commit', '--quiet', '-m', 'fixture seed');
    }
    const before = run(cwd, 'git', ['rev-parse', '--verify', 'HEAD']).stdout;
    await writeFile(path.join(cwd, 'governance.fail'), '');
    assert.equal(install(cwd).status, 0);
    if (change === 'add') {
      await mkdir(path.join(cwd, 'docs'));
      await writeFile(path.join(cwd, 'docs', 'fixture with spaces.md'), '# Fixture\n');
      git(cwd, 'add', '--', 'docs');
    } else if (change === 'delete') {
      git(cwd, 'rm', '--', 'AGENTS.md');
    } else {
      git(cwd, 'mv', '--', 'AGENTS.md', 'ordinary.txt');
    }

    const commit = run(cwd, 'git', ['commit', '--quiet', '-m', `fixture ${change}`]);
    assert.notEqual(commit.status, 0);
    assert.match(
      commit.stdout + commit.stderr,
      /governance fixture failure/,
      JSON.stringify({ status: commit.status, stdout: commit.stdout, stderr: commit.stderr }),
    );
    assert.equal(run(cwd, 'git', ['rev-parse', '--verify', 'HEAD']).stdout, before);
    assert.equal(await readFile(path.join(cwd, 'observed.log'), 'utf8'), 'governance\n');
  });
}

test('pre-push blocks a failed type check and allows a passing push to an isolated local remote', async (context) => {
  const { cwd, temporary } = await fixture(context);
  await seed(cwd);
  const remote = path.join(temporary, 'local remote.git');
  git(cwd, 'init', '--bare', '--quiet', remote);
  git(cwd, 'remote', 'add', 'fixture', remote);
  assert.equal(install(cwd).status, 0);
  await writeFile(path.join(cwd, 'types.fail'), '');

  const denied = run(cwd, 'git', ['push', 'fixture', 'HEAD:refs/heads/checked']);
  assert.notEqual(denied.status, 0);
  assert.match(denied.stdout + denied.stderr, /types fixture failure/);
  assert.notEqual(run(remote, 'git', ['rev-parse', '--verify', 'refs/heads/checked']).status, 0);

  await rm(path.join(cwd, 'types.fail'));
  git(cwd, 'push', 'fixture', 'HEAD:refs/heads/checked');
  assert.equal(git(remote, 'rev-parse', 'refs/heads/checked'), git(cwd, 'rev-parse', 'HEAD'));
  assert.equal(await readFile(path.join(cwd, 'observed.log'), 'utf8'), 'types\ntypes\n');
});

test('manual pre-push runs type checking without an outgoing file list', async (context) => {
  const { cwd } = await fixture(context);
  await seed(cwd);
  assert.equal(install(cwd).status, 0);
  await writeFile(path.join(cwd, 'types.fail'), '');

  const result = run(cwd, process.execPath, [lefthook, 'run', 'pre-push']);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /types fixture failure/);
  assert.equal(await readFile(path.join(cwd, 'observed.log'), 'utf8'), 'types\n');
});

test('installer leaves a custom hook directory and its configuration unchanged', async (context) => {
  const { cwd, temporary } = await fixture(context);
  const custom = path.join(temporary, 'custom hooks');
  await mkdir(custom);
  const existing = '#!/bin/sh\nexit 0\n';
  await writeFile(path.join(custom, 'pre-commit'), existing);
  git(cwd, 'config', 'core.hooksPath', custom);
  const config = await readFile(path.join(cwd, '.git/config'));

  const result = install(cwd);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /custom core.hooksPath/);
  assert.deepEqual(await readFile(path.join(cwd, '.git/config')), config);
  assert.equal(await readFile(path.join(custom, 'pre-commit'), 'utf8'), existing);
});

test('installer preserves an existing unmanaged pre-push hook', async (context) => {
  const { cwd } = await fixture(context);
  const hookPath = path.join(cwd, '.git/hooks/pre-push');
  await writeFile(hookPath, '#!/bin/sh\nexit 0\n');
  const original = await readFile(hookPath);
  assert.notEqual(install(cwd).status, 0);
  assert.deepEqual(await readFile(hookPath), original);
  assert.equal(existsSync(`${hookPath}.old`), false);
});

test('installer skips CI, production and source directories nested inside another checkout', async (context) => {
  const { cwd } = await fixture(context);
  for (const env of [{ CI: 'true' }, { NODE_ENV: 'production' }]) {
    assert.equal(install(cwd, env).status, 0);
    assert.equal(existsSync(path.join(cwd, '.git/hooks/pre-commit')), false);
  }
  const nested = path.join(cwd, 'source archive');
  await mkdir(nested);
  await writeFile(path.join(nested, 'lefthook.yml'), 'pre-commit: {}\n');
  assert.equal(install(nested).status, 0);
  assert.equal(existsSync(path.join(cwd, '.git/hooks/pre-commit')), false);
  assert.equal(readFileSync(path.join(cwd, '.git/config'), 'utf8').includes('hooksPath'), false);
});

test('installer detects a pre-push hook preserved by dependency installation', async (context) => {
  const { cwd } = await fixture(context);
  const hookPath = path.join(cwd, '.git/hooks/pre-push');
  const original = '#!/bin/sh\nexit 0\n';
  await writeFile(hookPath, original, { mode: 0o755 });
  assert.equal(run(cwd, process.execPath, [lefthook, 'install']).status, 0);
  assert.equal(await readFile(`${hookPath}.old`, 'utf8'), original);
  const result = install(cwd);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pre-push hook needs explicit integration/);
  assert.equal(await readFile(`${hookPath}.old`, 'utf8'), original);
  assert.equal(run(cwd, process.execPath, [lefthook, 'uninstall']).status, 0);
  assert.equal(await readFile(hookPath, 'utf8'), original);
});
