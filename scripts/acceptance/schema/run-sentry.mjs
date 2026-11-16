import { build } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import bundledDependencies from '../../build/standalone-bundled-dependencies.json' with { type: 'json' };

const directory = await mkdtemp(path.join(os.tmpdir(), 'agm-schema-sentry-'));
try {
  await build({
    configFile: false,
    logLevel: 'error',
    resolve: { alias: { '@': path.resolve('src') } },
    ssr: { noExternal: Object.keys(bundledDependencies) },
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
  const runtime = path.resolve(
    process.argv[2] ??
      path.join('dist/.runtime', `${process.platform}-${process.arch}`, 'standalone'),
  );
  const executable = path.join(
    runtime,
    process.platform === 'win32' ? 'node/node.exe' : 'node/node',
  );
  const env = { ...process.env, NODE_PATH: path.join(runtime, 'node_modules') };
  delete env.NODE_OPTIONS;
  const result = spawnSync(executable, [path.join(directory, 'sentry.cjs')], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 16_000,
    windowsHide: true,
    env,
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
