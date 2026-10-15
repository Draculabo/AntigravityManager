import { build } from 'vite';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import dotenv from 'dotenv';
import { createServer } from 'node:net';

const live = process.argv.includes('--live');
const offline = process.argv.includes('--offline');
const packaged = process.argv.includes('--packaged');
if (live && offline) {
  throw new Error('Live and offline modes are mutually exclusive');
}
const workspace = path.resolve('out/correlated-diagnostics');
await mkdir(workspace, { recursive: true });
const directory = await mkdtemp(path.join(workspace, 'sdk-'));
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
let dsn = process.env.SENTRY_DSN;
if (live && !dsn) {
  dsn = dotenv.parse(await readFile('.env', 'utf8')).SENTRY_DSN;
}
if (live && !dsn) {
  throw new Error('Live acceptance requires SENTRY_DSN');
}
await writeFile(
  path.join(directory, 'desktop-preferences.json'),
  JSON.stringify({ preferences: { error_reporting_enabled: true, telemetry_enabled: false } }),
);
await writeFile(
  path.join(directory, 'package.json'),
  JSON.stringify({ name: 'agm-operation-acceptance', version, main: 'electron-bootstrap.cjs' }),
);
await writeFile(
  path.join(directory, 'electron-bootstrap.cjs'),
  "const {app}=require('electron'); app.setPath('userData', process.env.AGM_DIAGNOSTIC_DIRECTORY); try { require('./electron.cjs'); } catch(error) { console.error('Acceptance bootstrap failed:', error.stack); app.exit(1); }\n",
);
const environment = {
  ...process.env,
  AGM_DIAGNOSTIC_DIRECTORY: directory,
  AGM_DIAGNOSTIC_LIVE: String(live),
  AGM_DIAGNOSTIC_OFFLINE: String(offline),
  ANTIGRAVITY_DESKTOP_PREFERENCES_PATH: path.join(directory, 'desktop-preferences.json'),
  AGM_DIAGNOSTIC_LIVE_DSN: live ? dsn : '',
  SENTRY_RELEASE: `antigravity-manager@${version}`,
  SENTRY_ENVIRONMENT: 'test',
};
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.SENTRY_AUTH_TOKEN;
for (const runtime of ['node', 'electron']) {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  environment.AGM_DIAGNOSTIC_RECEIVER_PORT = String(port);
  environment.SENTRY_DSN = `http://${live ? new URL(dsn).username : 'controlled'}@127.0.0.1:${port}/1`;
  await build({
    configFile: false,
    logLevel: 'error',
    resolve: {
      alias: {
        '@/shared/platform/paths': path.resolve('scripts/acceptance/diagnostics/isolated-paths.ts'),
        '@': path.resolve('src'),
      },
    },
    ...(packaged && runtime === 'electron' ? { ssr: { noExternal: true } } : {}),
    build: {
      ssr: true,
      target: 'node22',
      outDir: directory,
      emptyOutDir: false,
      rollupOptions: {
        input: `scripts/acceptance/diagnostics/${runtime}-sentry.ts`,
        external:
          packaged && runtime === 'electron'
            ? ['electron']
            : ['electron', '@sentry/node', '@sentry/electron/main'],
        output: {
          format: 'cjs',
          entryFileNames: `${runtime}.cjs`,
          // Native CommonJS modules can expose inherited enumerable properties without descriptors.
          ...(packaged ? { externalLiveBindings: false } : {}),
        },
      },
    },
  });
  let executable = runtime === 'node' ? process.execPath : (await import('electron')).default;
  let args = [runtime === 'electron' ? directory : path.join(directory, `${runtime}.cjs`)];
  if (packaged && runtime === 'electron') {
    const { default: packager } = await import('@electron/packager');
    const electronVersion = JSON.parse(
      await readFile('node_modules/electron/package.json', 'utf8'),
    ).version;
    const [application] = await packager({
      dir: directory,
      out: path.join(directory, 'packaged'),
      name: 'agm-operation-acceptance',
      platform: process.platform,
      arch: process.arch,
      electronVersion,
      asar: true,
      prune: false,
      ignore: /^\/packaged(?:\/|$)/,
    });
    executable =
      process.platform === 'darwin'
        ? path.join(
            application,
            'agm-operation-acceptance.app/Contents/MacOS/agm-operation-acceptance',
          )
        : path.join(
            application,
            `agm-operation-acceptance${process.platform === 'win32' ? '.exe' : ''}`,
          );
    args = [];
    environment.NODE_PATH = '';
  }
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    timeout: 45_000,
    maxBuffer: 128_000,
    windowsHide: true,
    env: environment,
  });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  await writeFile(path.join(directory, `${runtime}.log`), output);
  process.stdout.write(output.slice(-6000));
  if (result.status !== 0) {
    process.stdout.write(
      `${JSON.stringify({ runtime, exitCode: result.status, signal: result.signal, launchError: result.error?.code })}\n`,
    );
    process.exitCode = 1;
    break;
  }
}
process.stdout.write(`${JSON.stringify({ acceptanceDirectory: directory })}\n`);
