import { build } from 'vite';
import { mkdtemp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

if (!process.argv[2]) {
  throw new Error(
    'Usage: npm run test:schema:client -- <claude-executable> [Read|default|configured-mcp|configured-full]',
  );
}
const directory = await mkdtemp(path.join(os.tmpdir(), 'agm-schema-client-'));
await build({
  configFile: false,
  logLevel: 'error',
  build: {
    ssr: true,
    target: 'node22',
    outDir: directory,
    emptyOutDir: false,
    rollupOptions: {
      input: 'scripts/acceptance/schema/client.ts',
      output: { format: 'cjs', entryFileNames: 'client.cjs' },
    },
  },
});
const result = spawnSync(
  process.execPath,
  [path.join(directory, 'client.cjs'), path.resolve(process.argv[2]), process.argv[3] ?? 'Read'],
  {
    encoding: 'utf8',
    timeout: 150_000,
    maxBuffer: 16_000,
    windowsHide: true,
    env: { ...process.env, NODE_PATH: path.resolve('node_modules') },
  },
);
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exitCode = result.status ?? 1;
