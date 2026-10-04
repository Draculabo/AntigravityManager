import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { withNativeFixture } from './native-fixture.mjs';

test('native fixture copies built entries, isolates home and cleans up after a failed check', async () => {
  const originalDirectory = process.cwd();
  const root = await mkdtemp(path.join(os.tmpdir(), 'agm-native-fixture-test-'));
  const failure = new Error('Representative acceptance failure');
  try {
    await mkdir(path.join(root, 'node_modules/better-sqlite3'), { recursive: true });
    await mkdir(path.join(root, 'dist/core'), { recursive: true });
    await mkdir(path.join(root, 'dist/core/nested'));
    await writeFile(path.join(root, 'package.json'), '{}');
    await writeFile(
      path.join(root, 'node_modules/better-sqlite3/package.json'),
      '{"version":"1.0.0"}',
    );
    await writeFile(path.join(root, 'dist/core/main.cjs'), 'fixture core');
    process.chdir(root);
    await assert.rejects(
      withNativeFixture(root, 'agm-terminal-native-', async (fixture) => {
        assert.equal(fixture.project, root);
        assert.equal(path.dirname(fixture.directory), root);
        assert.equal(fixture.home, path.join(fixture.directory, 'home'));
        assert.equal(
          await readFile(path.join(fixture.directory, 'main.cjs'), 'utf8'),
          'fixture core',
        );
        assert.deepEqual((await readdir(fixture.directory)).sort(), [
          'home',
          'isolated-home.cjs',
          'main.cjs',
        ]);
        assert.match(await readFile(fixture.preload, 'utf8'), /AGM_DIAGNOSTIC_TEST_HOME/);
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.deepEqual((await readdir(root)).sort(), ['dist', 'node_modules', 'package.json']);
  } finally {
    process.chdir(originalDirectory);
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
});
