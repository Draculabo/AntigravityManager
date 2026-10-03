import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { queryProcesses } = require('@draculabo/sysinfo-process-enhanced');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-sysinfo-'));
const fixture = path.join(directory, 'query fixture 中文.cjs');
fs.writeFileSync(fixture, "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);\n");
const argumentsToCheck = [
  '--user-data-dir',
  path.join(directory, 'My Data 中文'),
  '--title=a"b',
  '',
  'trailing\\',
];
const child = spawn(process.execPath, [fixture, ...argumentsToCheck], {
  cwd: directory,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
try {
  await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'error').then(([error]) => {
      throw error;
    }),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture did not start')), 10000);
      timer.unref();
    }),
  ]);
  const started = performance.now();
  const rows = await queryProcesses(10000);
  const elapsedMs = performance.now() - started;
  const current = rows.find((row) => row.pid === child.pid);
  assert(current, 'The real fixture process must be observable');
  assert.equal(current.parentPid, process.pid);
  assert.equal(fs.realpathSync(current.exe), fs.realpathSync(process.execPath));
  assert.deepEqual(current.cmd.slice(1), [fixture, ...argumentsToCheck]);
  assert.equal(fs.realpathSync(current.cwd), fs.realpathSync(directory));
  assert.equal(typeof current.startTime, 'bigint');
  assert(current.startTime > 0n);
  await assert.rejects(async () => queryProcesses(0), /timeout must/);
  const report = JSON.stringify({
    platform: process.platform,
    runtime: process.versions.electron ? 'Electron' : 'Node',
    elapsedMs: Math.round(elapsedMs),
    argvPreserved: true,
    parentVerified: true,
    packageVersion: require('@draculabo/sysinfo-process-enhanced/package.json').version,
  });
  if (process.env.AGM_SYSINFO_REPORT_PATH) {
    fs.writeFileSync(process.env.AGM_SYSINFO_REPORT_PATH, report + '\n');
  }
  console.log(report);
} finally {
  child.kill();
  if (child.exitCode === null && child.signalCode === null) {
    await once(child, 'exit');
  }
  assert(directory.startsWith(os.tmpdir() + path.sep), 'Fixture cleanup must stay within temp');
  fs.rmSync(directory, { recursive: true, force: true });
}
