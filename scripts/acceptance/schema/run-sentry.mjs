import { build } from 'vite';
import { mkdtemp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const directory = await mkdtemp(path.join(os.tmpdir(), 'agm-schema-sentry-'));
await build({
  configFile: false,
  logLevel: 'error',
  resolve: { alias: { '@': path.resolve('src') } },
  build: {
    ssr: true,
    target: 'node22',
    outDir: directory,
    emptyOutDir: false,
    rollupOptions: {
      input: 'scripts/acceptance/schema/sentry.ts',
      output: { format: 'cjs', entryFileNames: 'sentry.cjs' },
    },
  },
});
const runtime = path.resolve('dist/.runtime', `${process.platform}-${process.arch}`, 'standalone');
const executable = path.join(runtime, process.platform === 'win32' ? 'node/node.exe' : 'node/node');
const dependencies = path.join(runtime, 'node_modules');
const result = spawnSync(executable, [path.join(directory, 'sentry.cjs')], {
  encoding: 'utf8',
  timeout: 30_000,
  maxBuffer: 16_000,
  windowsHide: true,
  env: { ...process.env, NODE_PATH: dependencies },
});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exitCode = result.status ?? 1;
