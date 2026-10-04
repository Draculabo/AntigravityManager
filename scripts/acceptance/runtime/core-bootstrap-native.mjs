import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildNativeEntry, runNativeEntry, withNativeFixture } from '../helpers/native-fixture.mjs';

const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 2 && args[0] === '--runtime-root'));
const runtimeRoot = path.resolve(args[1] ?? process.cwd());
await withNativeFixture(runtimeRoot, 'agm-bootstrap-native-', async (fixture) => {
  const { directory, preload } = fixture;
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
