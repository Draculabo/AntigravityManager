import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const support = path.join(root, 'src/tests/performance/support');
// Reuse the compiler already owned by Vite instead of adding a preview-only dependency.
const { build } = createRequire(import.meta.resolve('vite'))('esbuild');

export async function prepareReleaseNotesPreview() {
  const output = path.join(root, '.vite/release-notes-preview');
  mkdirSync(output, { recursive: true });
  await build({
    entryPoints: [path.join(support, 'release-notes-main.ts')],
    outfile: path.join(output, 'main.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    alias: {
      '@/shared/logging/logger': path.join(support, 'release-notes-logger.ts'),
      '@': path.join(root, 'src'),
    },
    logLevel: 'error',
  });
  await build({
    entryPoints: [path.join(root, 'src/preload.ts')],
    outfile: path.join(output, 'preload.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    define: { 'import.meta.env.ANTIGRAVITY_ENABLE_PERFORMANCE_RECORDER': '"0"' },
    logLevel: 'error',
  });
  const server = await createServer({
    configFile: false,
    root: support,
    cacheDir: path.join(root, 'node_modules/.vite/release-notes-preview'),
    logLevel: 'error',
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': path.join(root, 'src') } },
    optimizeDeps: { entries: ['release-notes.html'] },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
  });
  try {
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    if (!url) {
      throw new Error('The release-notes renderer did not open');
    }
    return { server, url, main: path.join(output, 'main.cjs') };
  } catch (error) {
    await server.close();
    throw error;
  }
}

async function runCli() {
  const { values } = parseArgs({
    options: {
      tag: { type: 'string', default: 'v0.23.0' },
      live: { type: 'boolean', default: false },
      language: { type: 'string', default: 'zh-CN' },
    },
  });
  const preview = await prepareReleaseNotesPreview();
  const profile = mkdtempSync(path.join(root, '.vite/release-notes-preview/profile-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.AGM_RELEASE_NOTES_URL = `${preview.url}release-notes.html?language=${encodeURIComponent(values.language)}`;
  env.AGM_RELEASE_NOTES_CONFIGURATION = JSON.stringify({
    mode: values.live ? 'live' : 'ready',
    state: 'downloading',
    tagName: values.tag,
  });
  const executable = createRequire(import.meta.url)('electron');
  const child = spawn(executable, [preview.main, `--user-data-dir=${profile}`], {
    env,
    stdio: 'inherit',
    // This process is the requested interactive preview window, not a background helper.
    windowsHide: false,
  });
  console.log(
    `Starting release-notes preview: mode=${values.live ? 'live' : 'ready'}, tag=${values.tag}.`,
  );
  console.log('The terminal stays running until you close the preview window.');
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  }).finally(() => preview.server.close());
  process.exitCode = exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
