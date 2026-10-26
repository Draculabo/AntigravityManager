import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const support = path.join(root, 'src/tests/performance/support');
const { build } = createRequire(import.meta.resolve('vite'))('esbuild');

export async function prepareErrorNotificationPreview() {
  const output = path.join(root, '.vite/error-notification-preview');
  mkdirSync(output, { recursive: true });
  await build({
    entryPoints: [path.join(support, 'error-notifications-main.ts')],
    outfile: path.join(output, 'main.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron', '@draculabo/sysinfo-process-enhanced'],
    alias: { '@': path.join(root, 'src') },
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
    cacheDir: path.join(root, 'node_modules/.vite/error-notification-preview'),
    logLevel: 'error',
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': path.join(root, 'src') } },
    optimizeDeps: { entries: ['error-notifications.html'] },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
  });
  try {
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    if (!url) {
      throw new Error('The error-notification renderer did not open.');
    }
    return { server, url, main: path.join(output, 'main.cjs') };
  } catch (error) {
    await server.close();
    throw error;
  }
}

async function runCli() {
  const preview = await prepareErrorNotificationPreview();
  try {
    const profile = mkdtempSync(path.join(root, '.vite/error-notification-preview/profile-'));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    env.AGM_ERROR_PREVIEW_URL = `${preview.url}error-notifications.html`;
    env.AGM_ERROR_PREVIEW_VERSION = JSON.parse(
      readFileSync(path.join(root, 'package.json'), 'utf8'),
    ).version;
    const child = spawn(
      createRequire(import.meta.url)('electron'),
      [preview.main, `--user-data-dir=${profile}`],
      {
        env,
        stdio: 'inherit',
        // This is the interactive demo requested by the user.
        windowsHide: false,
      },
    );
    console.log('Starting the isolated error-notification demo. Close its window to stop.');
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
  } finally {
    await preview.server.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runCli().catch(() => {
    console.error('The error-notification demo could not start.');
    process.exitCode = 1;
  });
}
