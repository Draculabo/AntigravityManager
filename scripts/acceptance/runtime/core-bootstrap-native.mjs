import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { buildNativeEntry, runNativeEntry, withNativeFixture } from '../helpers/native-fixture.mjs';

const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 2 && args[0] === '--runtime-root'));
const runtimeRoot = path.resolve(args[1] ?? process.cwd());
await withNativeFixture(runtimeRoot, 'agm-bootstrap-native-', async (fixture) => {
  const { directory, preload } = fixture;
  const errorDirectory = path.join(fixture.home, '.antigravity-agent', 'error-diagnostics');
  await mkdir(errorDirectory, { recursive: true });
  const errorWorker = new Worker(path.join(directory, 'error-window.worker.js'), {
    workerData: { databasePath: path.join(errorDirectory, 'core.errors.db'), role: 'core' },
  });
  let errorCommandId = 0;
  const errorCommand = (operation, payload) =>
    new Promise((resolve, reject) => {
      const id = ++errorCommandId;
      const done = (error, value) => {
        clearTimeout(timeout);
        errorWorker.off('message', reply);
        errorWorker.off('error', failed);
        errorWorker.off('exit', exited);
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      };
      const failed = (error) => done(error);
      const exited = (code) => done(new Error(`Error fixture worker exited: ${code}`));
      const reply = (message) => {
        if (message.id === id) {
          done(message.error ? new Error(message.error) : null, message.result);
        }
      };
      const timeout = setTimeout(() => done(new Error('Error fixture command timed out')), 5000);
      errorWorker.on('message', reply);
      errorWorker.on('error', failed);
      errorWorker.on('exit', exited);
      errorWorker.postMessage({ id, operation, payload });
    });
  try {
    const generation = randomUUID();
    await errorCommand('initialize', { generation, allocationBytes: 250 * 1024 * 1024 });
    const stack = 'Error: isolated diagnostic\n' + '    at 诊断😀 (fixture.ts:1:2)\n'.repeat(5000);
    await errorCommand('insert', {
      generation,
      body: JSON.stringify({
        version: 1,
        id: '55555555-5555-4555-8555-555555555555',
        createdAt: '2020-01-01T00:00:00Z',
        role: 'core',
        source: 'native-bootstrap',
        module: null,
        functionName: null,
        stage: null,
        protocol: null,
        requestId: null,
        attemptId: null,
        category: 'fixture',
        status: null,
        message: 'isolated diagnostic',
        stack,
        stackComplete: true,
        causes: [],
      }),
    });
    await errorCommand('shutdown', null);
  } finally {
    await errorWorker.terminate();
  }
  // Disposable substitutes never load or write the user's OS credential store.
  const keytar = path.join(directory, 'node_modules/keytar');
  const keyring = path.join(directory, 'node_modules/@napi-rs/keyring');
  const electron = path.join(directory, 'node_modules/electron');
  await mkdir(keytar, { recursive: true });
  await mkdir(keyring, { recursive: true });
  await writeFile(path.join(keyring, 'package.json'), JSON.stringify({ main: 'index.cjs' }));
  await writeFile(
    path.join(keyring, 'index.cjs'),
    'const values = new Map(); module.exports.Entry = class { constructor(s,a) { this.id = s+":"+a; } getPassword() { return values.get(this.id) ?? null; } setPassword(v) { values.set(this.id,v); } deleteCredential() { return values.delete(this.id); } };\n',
  );
  await mkdir(electron, { recursive: true });
  await writeFile(
    path.join(keytar, 'package.json'),
    JSON.stringify({ name: 'keytar', main: 'index.cjs' }),
  );
  await writeFile(
    path.join(keytar, 'index.cjs'),
    'const entries = new Map(); module.exports = { findCredentials: async () => [], getPassword: async (s,a) => entries.get(s+":"+a) ?? null, setPassword: async (s,a,v) => { entries.set(s+":"+a,v); }, deletePassword: async (s,a) => entries.delete(s+":"+a) };\n',
  );
  await writeFile(
    path.join(electron, 'package.json'),
    JSON.stringify({ name: 'electron', main: 'index.cjs' }),
  );
  await writeFile(
    path.join(electron, 'index.cjs'),
    'throw new Error("Electron API touched in presentation composition acceptance");\n',
  );

  await buildNativeEntry(
    fixture,
    'scripts/acceptance/runtime/core-bootstrap-native-entry.ts',
    'bootstrap.cjs',
    { presentationOnly: true },
  );
  const presentationPreload = path.join(directory, 'presentation-only.cjs');
  await writeFile(
    presentationPreload,
    `
require(${JSON.stringify(preload)});
const forbidden = () => { throw new Error('Presentation opened owner-local native state'); };
require('better-sqlite3');
require.cache[require.resolve('better-sqlite3')].exports = forbidden;
require('keytar');
require.cache[require.resolve('keytar')].exports = { getPassword: forbidden, setPassword: forbidden, findCredentials: forbidden, deletePassword: forbidden };
require('node:worker_threads').Worker = forbidden;
`,
  );
  await writeFile(
    path.join(directory, 'isolated-core.cjs'),
    `require(${JSON.stringify(preload)}); process.execArgv.push('--require', ${JSON.stringify(preload)}); require('./main.cjs');\n`,
  );

  runNativeEntry(
    fixture,
    'bootstrap.cjs',
    'Core process bootstrap acceptance failed',
    presentationPreload,
  );
});
