import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { traceRuntime } from './trace-standalone-runtime.mjs';

test('runtime tracing excludes host assets while retaining all explicit native entries', async () => {
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
    ]) {
      await file(entry, 'module.exports = {};');
    }
    const keyring = `@napi-rs/keyring-${process.platform}-${process.arch}${process.platform === 'win32' ? '-msvc' : process.platform === 'linux' ? '-gnu' : ''}`;
    const koffi = `@koromix/koffi-${process.platform}-${process.arch}`;
    const sysinfo = `@draculabo/sysinfo-process-enhanced-${process.platform}-${process.arch}${process.platform === 'win32' ? '-msvc' : process.platform === 'linux' ? '-gnu' : ''}`;
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
    const binaries = [
      'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      'node_modules/keytar/build/Release/keytar.node',
      `node_modules/${keyring}/keyring.node`,
      `node_modules/${sysinfo}/sysinfo.node`,
      `node_modules/${koffi}/${process.platform}_${process.arch}/koffi.node`,
    ];
    for (const binary of binaries) {
      await file(binary, Buffer.alloc(0));
    }
    const trace = await traceRuntime(root);
    assert.equal(trace.warnings.length, 1);
    assert.match(trace.warnings[0], /Failed to resolve dependency "original-fs"/);
    assert(trace.files.includes(path.normalize('node_modules/@electron/asar/lib/wrapped-fs.js')));
    assert(!trace.files.some((entry) => entry.includes('host-only-marker')));
    for (const binary of binaries) {
      assert(trace.files.includes(path.normalize(binary)), `Missing native entry: ${binary}`);
    }
  } finally {
    assert.equal(path.dirname(await realpath(root)), parent);
    assert.equal(path.dirname(await realpath(outside)), outsideParent);
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
