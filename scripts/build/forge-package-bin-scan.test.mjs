import assert from 'node:assert/strict';
import fs from 'node:fs';
import promises from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import vm from 'node:vm';
import glob from 'fast-glob';

test('the installed Forge bin cleanup scans only its package directory', async (t) => {
  await promises.mkdir('out', { recursive: true });
  const out = await promises.realpath('out');
  const fixture = await promises.mkdtemp(path.join(out, 'forge-bin-scan-'));
  const buildPath = path.join(fixture, 'package (fixture) 中文');
  const bin = path.join(buildPath, 'node_modules', 'local-tool', '.bin', 'fixture.cmd');
  await promises.mkdir(path.dirname(bin), { recursive: true });
  await promises.writeFile(bin, 'fixture');
  t.after(async () => {
    assert.equal(path.dirname(await promises.realpath(fixture)), out);
    await promises.rm(fixture, { recursive: true, force: true, maxRetries: 5 });
  });

  const scanned = [];
  const scopedGlob = Object.assign(
    (patterns, options) =>
      glob(patterns, {
        ...options,
        fs: {
          ...fs,
          readdir(directory, settings, callback) {
            const resolved = path.resolve(directory);
            scanned.push(resolved);
            if (resolved !== buildPath && !resolved.startsWith(`${buildPath}${path.sep}`)) {
              callback(
                Object.assign(new Error('Scan escaped the package directory'), { code: 'EPERM' }),
              );
              return;
            }
            fs.readdir(directory, settings, callback);
          },
        },
      }),
    glob,
  );

  const packageFile = path.resolve('node_modules/@electron-forge/core/dist/api/package.js');
  const require = createRequire(packageFile);
  const removed = [];
  let capturedOptions;
  let exerciseCleanup = false;
  let copyHook = 0;
  class Tasks {
    constructor(tasks) {
      this.tasks = tasks;
    }
  }
  // Execute the installed cleanup hook, with no packager, native rebuild or external scan.
  const overrides = {
    'fast-glob': scopedGlob,
    'fs-extra': {
      ...require('fs-extra'),
      async remove(file) {
        removed.push(path.resolve(file));
      },
    },
    'node:util': {
      ...require('node:util'),
      promisify(action) {
        if (exerciseCleanup && ++copyHook > 2) {
          return async () => {};
        }
        return promisify(action);
      },
    },
    '@electron/packager': {
      ...require('@electron/packager'),
      async packager(options) {
        capturedOptions = options;
        await promisify(options.afterFinalizePackageTargets[0])([
          { platform: process.platform, arch: process.arch },
        ]);
        return [];
      },
    },
    '@electron-forge/core-utils': {
      ...require('@electron-forge/core-utils'),
      getElectronVersion: async () => '38.0.0',
    },
    '@electron-forge/tracer': {
      autoTrace: (_metadata, action) => action,
      delayTraceTillSignal: (_trace, tasks) => tasks,
    },
    listr2: { Listr: Tasks },
  };
  const exports = {};
  vm.runInNewContext(await promises.readFile(packageFile, 'utf8'), {
    exports,
    module: { exports },
    require: (name) => overrides[name] ?? require(name),
    process,
  });
  const trace = (_metadata, action) => (context, task) => action(trace, context, task);
  const runner = exports.listrPackage(trace, { dir: fixture });
  await runner.tasks[2].task(
    {
      dir: fixture,
      calculatedOutDir: path.join(fixture, 'output'),
      forgeConfig: { packagerConfig: { prune: false }, rebuildConfig: {} },
      packageJSON: { main: 'main.js', version: '1.0.0' },
    },
    { newListr: (tasks) => new Tasks(tasks) },
  );
  assert(capturedOptions);
  // Keep the copy signal and real bin cleanup; skip unrelated rebuild/write hooks.
  exerciseCleanup = true;
  await promisify(capturedOptions.afterCopy[0])(
    buildPath,
    '38.0.0',
    process.platform,
    process.arch,
  );
  assert.deepEqual(removed, [bin]);
  assert(scanned.length > 0);
});
