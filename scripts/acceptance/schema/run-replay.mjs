import { build } from 'vite';
import { mkdtemp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

if (!process.argv[2]) {
  throw new Error(
    'Usage: npm run test:schema:replay -- <audit-database-path> [limit] [all|unmarked]',
  );
}
const directory = await mkdtemp(path.join(os.tmpdir(), 'agm-schema-replay-'));
await build({
  configFile: false,
  logLevel: 'error',
  build: {
    ssr: true,
    target: 'node22',
    outDir: directory,
    emptyOutDir: false,
    rollupOptions: {
      input: 'scripts/acceptance/schema/replay-cli.ts',
      output: { format: 'cjs', entryFileNames: 'replay.cjs' },
    },
  },
});
// Bundled code only; raw traffic and credentials are never written to a fixture or temp file.
const result = spawnSync(
  process.execPath,
  [
    path.join(directory, 'replay.cjs'),
    path.resolve(process.argv[2]),
    process.argv[3] ?? '1000',
    process.argv[4] ?? 'all',
  ],
  {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16_000,
    windowsHide: true,
    env: { ...process.env, NODE_PATH: path.resolve('node_modules') },
  },
);
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exitCode = result.status ?? 1;
