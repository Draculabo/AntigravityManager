import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const makerRoot = path.dirname(
  require.resolve('@pengx17/electron-forge-maker-appimage/package.json'),
);
function loadCommonJs(source, directory, replacements) {
  const module = { exports: {} };
  const injectedRequire = Object.assign((name) => replacements[name] ?? require(name), {
    resolve: require.resolve,
  });
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    __dirname: directory,
    require: injectedRequire,
    process,
    console,
  });
  return module.exports;
}

test('AppImage maker forwards the requested architecture and preserves path arguments', async () => {
  const parent = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(parent, 'agm-appimage-maker-'));
  try {
    const calls = [];
    const patches = [];
    const source = await readFile(path.join(makerRoot, 'dist/src/MakerAppimage.js'), 'utf8');
    const { default: Maker } = loadCommonJs(source, makerRoot, {
      'app-builder-lib/out/util/appBuilder': {
        executeAppBuilderAsJson: async (args) => calls.push(args),
      },
      './patch-apprun': { patchAppImage: async (...args) => patches.push(args) },
    });
    for (const arch of ['x64', 'arm64']) {
      const output = path.join(directory, arch);
      const files = await new Maker().make({
        dir: path.join(directory, 'packaged app'),
        makeDir: output,
        appName: 'Manager',
        targetArch: arch,
        targetPlatform: 'linux',
        packageJSON: { version: '1.2.3', productName: 'Manager', description: 'Fixture' },
        forgeConfig: { makers: [], packagerConfig: { executableName: 'manager' } },
      });
      const args = calls.at(-1);
      assert.equal(args[args.indexOf('--arch') + 1], arch);
      assert.deepEqual(patches.at(-1), [files[0], arch]);
    }
    const commands = [];
    const helper = loadCommonJs(
      await readFile(path.join(makerRoot, 'dist/src/patch-apprun.js'), 'utf8'),
      path.join(makerRoot, 'dist/src'),
      {
        child_process: { execFileSync: (...args) => commands.push(args) },
      },
    );
    await helper.patchAppImage('/tmp/a directory/Manager.AppImage', 'arm64');
    assert.equal(commands[0][0], 'bash');
    assert.deepEqual(Array.from(commands[0][1]), [
      path.join(makerRoot, 'scripts/patch-apprun.sh'),
      '/tmp/a directory/Manager.AppImage',
      'arm64',
    ]);
  } finally {
    assert.equal(path.dirname(await realpath(directory)), parent);
    await rm(directory, { recursive: true, force: true });
  }
});
