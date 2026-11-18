import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { traceRuntime } from './trace-standalone-runtime.mjs';
import bundledDependencies from './standalone-bundled-dependencies.json' with { type: 'json' };

test('runtime tracing excludes host assets while retaining all explicit native entries', async () => {
  await mkdir(path.resolve('dist/.runtime'), { recursive: true });
  const parent = await realpath(path.resolve('dist/.runtime'));
  const root = await mkdtemp(path.join(parent, 'trace-fixture-'));
  const outsideParent = await realpath(os.tmpdir());
  const outside = await mkdtemp(path.join(outsideParent, 'agm-trace-outside-'));
  async function file(relative, content) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  try {
    const external = path.join(outside, 'host-only-marker.txt');
    await writeFile(external, 'This test asset must never enter the runtime trace.');
    await file('package.json', '{}');
    await file(
      'core/main.cjs',
      `require('node:fs').readFileSync(${JSON.stringify(external)}); require('@electron/asar');`,
    );
    await file('node_modules/@electron/asar/package.json', '{"main":"lib/wrapped-fs.js"}');
    await file(
      'node_modules/@electron/asar/lib/wrapped-fs.js',
      "module.exports = 'electron' in process.versions ? require('original-fs') : require('fs');",
    );
    for (const entry of [
      'cli/main.cjs',
      'core/traffic-audit.worker.js',
      'core/thought-store.worker.js',
      'core/error-window.worker.js',
    ]) {
      await file(entry, 'module.exports = {};');
    }
    const keyring = `@napi-rs/keyring-${process.platform}-${process.arch}${process.platform === 'win32' ? '-msvc' : process.platform === 'linux' ? '-gnu' : ''}`;
    const koffi = `@koromix/koffi-${process.platform}-${process.arch}`;
    const sysinfo = `@draculabo/sysinfo-process-enhanced-${process.platform}-${process.arch}${process.platform === 'win32' ? '-msvc' : process.platform === 'linux' ? '-gnu' : ''}`;
    const sqliteDirectory = 'node_modules/better-sqlite3/prebuilds';
    const otherSqliteBinary = `${sqliteDirectory}/other-target.node`;
    for (const name of [
      'better-sqlite3',
      'keytar',
      'koffi',
      '@napi-rs/keyring',
      '@draculabo/sysinfo-process-enhanced',
    ]) {
      await file(`node_modules/${name}/package.json`, '{"main":"index.js"}');
      await file(`node_modules/${name}/index.js`, 'module.exports = {};');
    }
    await file(`node_modules/${keyring}/package.json`, '{"main":"keyring.node"}');
    await file(`node_modules/${sysinfo}/package.json`, '{"main":"sysinfo.node"}');
    await file(otherSqliteBinary, Buffer.alloc(0));
    await file('node_modules/better-sqlite3/index.js', "require('./lib/binding');");
    await file(
      'node_modules/better-sqlite3/lib/binding.js',
      `const path = require('node:path');
       require('../prebuilds/other-target.node');
       require(path.join(__dirname, '..', 'build', 'Debug', 'better_sqlite3.node'));
       require(path.join(__dirname, '..', 'build', 'Release', 'better_sqlite3.node'));`,
    );
    const binaries = [
      `${sqliteDirectory}/${process.platform}-${process.arch}.node`,
      'node_modules/keytar/build/Release/keytar.node',
      `node_modules/${keyring}/keyring.node`,
      `node_modules/${sysinfo}/sysinfo.node`,
      `node_modules/${koffi}/${process.platform}_${process.arch}/koffi.node`,
    ];
    for (const binary of binaries) {
      await file(binary, Buffer.alloc(0));
    }
    // pnpm's store imports have multiple hardlinks, including content shared across packages.
    const declarations = [];
    for (let i = 0; i < 80; i++) {
      const name = 'linked-fixture-' + String(i).padStart(3, '0');
      await file('store/' + name + '.js', 'module.exports = ' + i + ';');
      await file('node_modules/' + name + '/package.json', JSON.stringify({ main: 'index.js' }));
      await link(
        path.join(root, 'store', name + '.js'),
        path.join(root, 'node_modules', name, 'index.js'),
      );
      if (i === 0) {
        await file('store/LICENSE', 'Shared fixture license');
      }
      await link(
        path.join(root, 'store/LICENSE'),
        path.join(root, 'node_modules', name, 'LICENSE'),
      );
      declarations.push(`require('${name}');`);
    }
    const core = await readFile(path.join(root, 'core/main.cjs'), 'utf8');
    await file('core/main.cjs', core + declarations.join(''));
    const trace = await traceRuntime(root);
    assert.equal(trace.warnings.length, 3);
    assert(trace.warnings.some((warning) => warning.includes('dependency "original-fs"')));
    assert.equal(
      trace.warnings.filter((warning) => warning.includes('better_sqlite3.node')).length,
      2,
    );
    assert(trace.files.includes(path.normalize('node_modules/@electron/asar/lib/wrapped-fs.js')));
    assert(!trace.files.some((entry) => entry.includes('host-only-marker')));
    assert(!trace.files.includes(path.normalize(otherSqliteBinary)));
    for (const binary of binaries) {
      assert(trace.files.includes(path.normalize(binary)), `Missing native entry: ${binary}`);
    }
    await file('node/fixture', 'Node resource');
    await file('assets/fixture', 'Asset resource');
    await file('pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
    await file('LICENSE', 'Runtime license');
    for (const [name, importers] of Object.entries(bundledDependencies)) {
      const directory = [
        'node_modules',
        ...importers.flatMap((entry) => [entry, 'node_modules']),
        name,
      ].join('/');
      await file(
        `${directory}/package.json`,
        JSON.stringify({ name, version: '1.0.0', exports: './index.js' }),
      );
      await file(`${directory}/index.js`, 'module.exports = {};');
      if (name !== 'drizzle-orm') {
        const licenseName = ['jsonc-parser', 'uuid', 'radash'].includes(name)
          ? 'LICENSE.md'
          : 'LICENSE';
        await file(`${directory}/${licenseName}`, `${name} fixture license`);
      }
      if (importers.length > 0) {
        await file(`node_modules/${name}/package.json`, JSON.stringify({ name, version: '0.9.0' }));
        await file(`node_modules/${name}/LICENSE`, 'Incorrect top-level license');
      }
    }
    const output = path.join(outside, 'materialized');
    const moduleUrl = pathToFileURL(
      path.resolve('scripts/build/trace-standalone-runtime.mjs'),
    ).href;
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {materializeRuntime} from ${JSON.stringify(moduleUrl)}; await materializeRuntime(${JSON.stringify(root)}, ${JSON.stringify(output)});`,
      ],
      {
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
      },
    );
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    const expectedNotices = await Promise.all(
      Object.keys(bundledDependencies).map(async (name) => {
        const license =
          name === 'drizzle-orm'
            ? await readFile(new URL('./licenses/drizzle-orm.LICENSE', import.meta.url), 'utf8')
            : `${name} fixture license`;
        return `${name}@1.0.0\n\n${license.trimEnd()}`;
      }),
    );
    assert.equal(
      await readFile(path.join(output, 'THIRD-PARTY-NOTICES.txt'), 'utf8'),
      `${expectedNotices.join('\n\n')}\n`,
    );
    for (const name of Object.keys(bundledDependencies)) {
      await assert.rejects(readFile(path.join(output, 'node_modules', name, 'index.js')), {
        code: 'ENOENT',
      });
    }
    for (let i = 0; i < 80; i++) {
      const name = 'linked-fixture-' + String(i).padStart(3, '0');
      assert.equal(
        await readFile(path.join(output, 'node_modules', name, 'index.js'), 'utf8'),
        'module.exports = ' + i + ';',
      );
      assert.equal(
        await readFile(path.join(output, 'node_modules', name, 'LICENSE'), 'utf8'),
        'Shared fixture license',
      );
    }
  } finally {
    assert.equal(path.dirname(await realpath(root)), parent);
    assert.equal(path.dirname(await realpath(outside)), outsideParent);
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
