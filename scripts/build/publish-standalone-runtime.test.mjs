import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { publishStandaloneRuntime, RuntimeRecoveryError } from './publish-standalone-runtime.mjs';

const target = { platform: 'win32', arch: 'x64' };
const manifest = `${JSON.stringify({ version: 1, ...target })}\n`;

async function fixture(t) {
  await fs.mkdir('out', { recursive: true });
  const out = await fs.realpath('out');
  const parent = await fs.mkdtemp(path.join(out, 'runtime-publication-'));
  const stage = await fs.mkdtemp(path.join(parent, 'stage-'));
  const root = path.join(stage, 'standalone');
  const destination = path.join(parent, 'standalone');
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(parent)), out);
    await fs.rm(parent, { recursive: true, force: true, maxRetries: 5 });
  });
  await writeTree(root, {
    'runtime-manifest.json': manifest,
    'core/main.cjs': 'new core',
    'assets/fonts/font.txt': 'new font',
    'node/node.exe': 'new node',
  });
  return { root, destination, backup: path.join(stage, 'previous') };
}

async function writeTree(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
}

async function readTree(root) {
  const files = {};
  async function visit(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(file, `${relative}/`);
      } else {
        files[relative] = await fs.readFile(file, 'utf8');
      }
    }
  }
  await visit(root);
  return files;
}

async function previousRuntime(destination) {
  const files = {
    'runtime-manifest.json': manifest,
    'core/main.cjs': 'previous core',
    'assets/fonts/font.txt': 'previous font',
    'obsolete.txt': 'must not survive successful replacement',
  };
  await writeTree(destination, files);
  return files;
}

test('Windows publication never renames populated directories', async (t) => {
  const { root, destination } = await fixture(t);
  const expected = await readTree(root);
  const rename = t.mock.method(fs, 'rename', async () => {
    throw Object.assign(new Error('Windows directory rename denied'), { code: 'EPERM' });
  });
  await publishStandaloneRuntime(root, destination, target);
  assert.deepEqual(await readTree(destination), expected);
  assert.deepEqual(await readTree(root), expected);
  assert.equal(rename.mock.callCount(), 0);
});

test('Windows replacement retains a complete backup and excludes stale files', async (t) => {
  const { root, destination, backup } = await fixture(t);
  const previous = await previousRuntime(destination);
  const expected = await readTree(root);
  await publishStandaloneRuntime(root, destination, target);
  assert.deepEqual(await readTree(destination), expected);
  assert.deepEqual(await readTree(backup), previous);
});

test('a failed Windows copy removes partial output and restores the previous runtime', async (t) => {
  const { root, destination } = await fixture(t);
  const previous = await previousRuntime(destination);
  const copy = fs.cp;
  const failure = new Error('Interrupted runtime copy');
  t.mock.method(fs, 'cp', async (source, output, options) => {
    if (source === root && output === destination) {
      await writeTree(output, { 'partial.txt': 'unfinished' });
      throw failure;
    }
    await copy(source, output, options);
  });
  await assert.rejects(
    publishStandaloneRuntime(root, destination, target),
    (error) => error === failure,
  );
  assert.deepEqual(await readTree(destination), previous);
});

test('a failed first publication leaves no partial runtime', async (t) => {
  const { root, destination } = await fixture(t);
  const failure = new Error('Interrupted runtime copy');
  t.mock.method(fs, 'cp', async (_source, output) => {
    await writeTree(output, { 'partial.txt': 'unfinished' });
    throw failure;
  });
  await assert.rejects(
    publishStandaloneRuntime(root, destination, target),
    (error) => error === failure,
  );
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  assert.equal((await readTree(root))['core/main.cjs'], 'new core');
});

test('a backup failure leaves the current runtime untouched', async (t) => {
  const { root, destination } = await fixture(t);
  const previous = await previousRuntime(destination);
  const failure = new Error('Backup copy failed');
  t.mock.method(fs, 'cp', async () => {
    throw failure;
  });
  await assert.rejects(
    publishStandaloneRuntime(root, destination, target),
    (error) => error === failure,
  );
  assert.deepEqual(await readTree(destination), previous);
});

test('publication refuses an existing runtime for a different target', async (t) => {
  const { root, destination } = await fixture(t);
  await previousRuntime(destination);
  await fs.writeFile(
    path.join(destination, 'runtime-manifest.json'),
    JSON.stringify({ version: 1, ...target, arch: 'arm64' }),
  );
  const previous = await readTree(destination);
  await assert.rejects(publishStandaloneRuntime(root, destination, target), {
    code: 'ERR_ASSERTION',
  });
  assert.deepEqual(await readTree(destination), previous);
});

test('failed recovery identifies the retained backup and reports both failures', async (t) => {
  const { root, destination, backup } = await fixture(t);
  const previous = await previousRuntime(destination);
  const copy = fs.cp;
  const failure = new Error('Interrupted runtime copy');
  const rollback = new Error('Recovery copy failed');
  t.mock.method(fs, 'cp', async (source, output, options) => {
    if (source === root) {
      throw failure;
    }
    if (source === backup) {
      throw rollback;
    }
    await copy(source, output, options);
  });
  await assert.rejects(publishStandaloneRuntime(root, destination, target), (error) => {
    assert(error instanceof RuntimeRecoveryError);
    assert.deepEqual(error.errors, [failure, rollback]);
    assert(error.message.includes(backup));
    return true;
  });
  assert.deepEqual(await readTree(backup), previous);
});
