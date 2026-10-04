import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import spawn from 'cross-spawn';
import { build, loadConfigFromFile } from 'vite';

// Build beside the selected Node dependencies without replacing Electron's native binaries.
export async function withNativeFixture(runtimeRoot, prefix, action) {
  const project = process.cwd();
  const workspaceRequire = createRequire(path.join(project, 'package.json'));
  const runtimeRequire = createRequire(path.join(runtimeRoot, 'package.json'));
  assert.equal(
    runtimeRequire('better-sqlite3/package.json').version,
    workspaceRequire('better-sqlite3/package.json').version,
    'Native dependency version must match the workspace',
  );
  const directory = await mkdtemp(path.join(runtimeRoot, prefix));
  try {
    const home = path.join(directory, 'home');
    await mkdir(home);
    for (const entry of await readdir(path.join(project, 'dist/core'), { withFileTypes: true })) {
      if (entry.isFile()) {
        await copyFile(
          path.join(project, 'dist/core', entry.name),
          path.join(directory, entry.name),
        );
      }
    }
    const preload = path.join(directory, 'isolated-home.cjs');
    await writeFile(
      preload,
      "const home = process.env.AGM_DIAGNOSTIC_TEST_HOME; if (!home) throw new Error('Missing isolated test home'); require('node:os').homedir = () => home;\n",
    );
    await action({ project, directory, home, preload });
  } finally {
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), runtimeRoot);
    assert(path.basename(target).startsWith(prefix));
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

export async function buildNativeEntry(
  fixture,
  entry,
  filename,
  { presentationOnly = false } = {},
) {
  const loaded = await loadConfigFromFile(
    { command: 'build', mode: 'production' },
    path.join(fixture.project, 'vite.core.config.mts'),
  );
  assert(loaded);
  await build({
    ...loaded.config,
    ...(presentationOnly ? { plugins: [] } : {}),
    configFile: false,
    logLevel: 'error',
    build: {
      ...loaded.config.build,
      outDir: fixture.directory,
      emptyOutDir: false,
      sourcemap: false,
      rollupOptions: {
        ...loaded.config.build?.rollupOptions,
        ...(presentationOnly
          ? {
              external: [
                ...loaded.config.build.rollupOptions.external,
                'electron',
                'electron/main',
              ],
            }
          : {}),
        input: path.join(fixture.project, entry),
        output: {
          format: 'cjs',
          entryFileNames: filename,
          chunkFileNames: 'acceptance-[name]-[hash].cjs',
        },
      },
    },
  });
}

export function runNativeEntry(fixture, filename, message, preload = fixture.preload) {
  const child = spawn.sync(
    process.execPath,
    ['--require', preload, path.join(fixture.directory, filename)],
    {
      cwd: fixture.directory,
      env: {
        ...process.env,
        AGM_DIAGNOSTIC_TEST_HOME: fixture.home,
        NODE_PATH: path.join(fixture.project, 'node_modules'),
      },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 6000,
    },
  );
  process.stdout.write(child.stdout ?? '');
  process.stderr.write(child.stderr ?? '');
  if (child.error) {
    throw child.error;
  }
  assert.equal(child.status, 0, message);
}
