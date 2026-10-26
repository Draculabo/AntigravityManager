import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runNativeEntry, withNativeFixture } from './native-fixture.mjs';

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
        const profileEntry = path.join(fixture.directory, 'profile.cjs');
        const profileResult = path.join(fixture.directory, 'profile.json');
        await writeFile(
          profileEntry,
          `require('node:fs').writeFileSync(${JSON.stringify(profileResult)}, JSON.stringify({ home: require('node:os').homedir(), roaming: process.env.APPDATA, local: process.env.LOCALAPPDATA, user: process.env.USERPROFILE, config: process.env.XDG_CONFIG_HOME, data: process.env.XDG_DATA_HOME }));`,
        );
        runNativeEntry(
          fixture,
          'profile.cjs',
          'Native fixture must isolate platform profile roots',
        );
        const profile = JSON.parse(await readFile(profileResult, 'utf8'));
        assert.equal(profile.home, fixture.home);
        for (const key of ['roaming', 'local', 'user', 'config', 'data']) {
          assert.equal(typeof profile[key], 'string', `${key} must be explicitly isolated`);
          const relative = path.relative(fixture.home, profile[key]);
          assert(
            !relative.startsWith('..') && !path.isAbsolute(relative),
            `${key} escaped the fixture home`,
          );
        }
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
