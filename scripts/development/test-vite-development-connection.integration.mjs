import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import tailwindcss from '@tailwindcss/vite';
import spawn from 'cross-spawn';
import { createServer, loadConfigFromFile } from 'vite';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { getConfig } = require('@electron-forge/plugin-vite/dist/config/vite.renderer.config.js');
const { getBuildDefine } = require('@electron-forge/plugin-vite/dist/config/vite.base.config.js');
const projectRoot = process.cwd();
const configFile = path.resolve('vite.renderer.config.mts');
await mkdir('out', { recursive: true });
const temporaryParent = await realpath('out');
const directory = await mkdtemp(path.join(temporaryParent, 'agm-vite-connection-'));
const ignoredDirectories = [
  'out',
  'dist',
  '.tmp',
  '.local-tools',
  'artifacts',
  'nested-checkout',
  'nested-worktree',
];
for (const name of ignoredDirectories) {
  await mkdir(path.join(directory, name), { recursive: true });
  await writeFile(path.join(directory, name, 'probe.txt'), 'initial');
}
await mkdir(path.join(directory, 'nested-checkout', '.git'));
await writeFile(path.join(directory, 'nested-worktree', '.git'), 'gitdir: fixture-only');
await writeFile(path.join(directory, 'nested-worktree', 'view.html'), '<div class="z-[81049]">');
await mkdir(path.join(directory, 'src/styles'), { recursive: true });
await writeFile(
  path.join(directory, 'src/styles/global.css'),
  await readFile(path.join(projectRoot, 'src/styles/global.css')),
);
const moduleFile = path.join(directory, 'src', 'probe.js');
const moduleSource = (value) =>
  `document.querySelector('h1').classList.add('z-[81047]');
window.__WATCH_PROBE_VALUE__ = '${value}'; if (import.meta.hot) { import.meta.hot.accept(); }`;
await writeFile(moduleFile, moduleSource('initial'));
let loaded;
// Resolve the real development policy against a small isolated workspace, including Git markers.
process.chdir(directory);
try {
  loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, configFile);
} finally {
  process.chdir(projectRoot);
}
assert.equal(loaded?.config.server?.host, '127.0.0.1');
const rendererName = 'main_window';
const config = getConfig(
  { root: directory, mode: 'development', forgeConfigSelf: { name: rendererName } },
  {
    plugins: [tailwindcss()],
    server: {
      ...loaded.config.server,
      port: 5173,
      watch: {
        ...loaded.config.server.watch,
        ignored: [...(loaded.config.server.watch?.ignored ?? []), '**/profile/**'],
      },
    },
    logLevel: 'error',
  },
);
const server = await createServer({ ...config, configFile: false });
let child;
try {
  await writeFile(
    path.join(directory, 'index.html'),
    '<h1 class="z-[81048]">Development connection verified</h1>' +
      '<script type="module" src="/src/probe.js"></script>',
  );
  const stylesheet = await server.transformRequest('/src/styles/global.css?direct');
  assert(stylesheet);
  assert(/z-index: 81047\b/.test(stylesheet.code), 'Tailwind omitted a class from renderer source');
  assert(/z-index: 81048\b/.test(stylesheet.code), 'Tailwind omitted a class from the HTML entry');
  assert(!/z-index: 81049\b/.test(stylesheet.code), 'Tailwind scanned a nested worktree');
  await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address === 'object');
  assert.equal(address.address, '127.0.0.1');

  const definitions = getBuildDefine({
    command: 'serve',
    forgeConfig: { renderer: [{ name: rendererName }] },
  });
  const url = JSON.parse(definitions.MAIN_WINDOW_VITE_DEV_SERVER_URL);
  assert.equal(url, `http://localhost:${address.port}`);

  const resultFile = path.join(directory, 'result.json');
  const readyFile = path.join(directory, 'ready.json');
  const entry = path.join(directory, 'main.cjs');
  await writeFile(
    entry,
    `const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
app.whenReady().then(async () => {
  try {
    const window = new BrowserWindow({ show: false });
    await window.loadURL('http://localhost:' + process.argv[2] + '/');
    const text = await window.webContents.executeJavaScript('document.body.textContent');
    const initial = await window.webContents.executeJavaScript('window.__WATCH_PROBE_VALUE__');
    writeFileSync(process.argv[4], JSON.stringify({ text, initial }));
    const deadline = Date.now() + 10000;
    let value;
    while (Date.now() < deadline) {
      value = await window.webContents.executeJavaScript('window.__WATCH_PROBE_VALUE__');
      if (value === 'updated') {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    writeFileSync(process.argv[3], JSON.stringify({ text, initial, value }));
    app.quit();
  } catch (error) {
    console.error(error.message);
    app.exit(1);
  }
});
setTimeout(() => app.exit(1), 15000).unref();
`,
  );
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.NODE_OPTIONS;
  child = spawn(
    require('electron'),
    [
      entry,
      String(address.port),
      resultFile,
      readyFile,
      `--user-data-dir=${path.join(directory, 'profile')}`,
    ],
    {
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      output = (output + chunk).slice(-4000);
    });
  }
  const closed = once(child, 'close');
  const deadline = Date.now() + 12000;
  let ready;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      ready = JSON.parse(await readFile(readyFile, 'utf8'));
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    await delay(100);
  }
  assert.equal(ready?.initial, 'initial', output);
  const watched = Object.keys(server.watcher.getWatched()).map((file) => path.resolve(file));
  for (const name of ignoredDirectories) {
    const target = path.join(directory, name);
    assert(
      !watched.some((file) => file === target || file.startsWith(target + path.sep)),
      `Development watcher included excluded directory: ${name}`,
    );
  }
  let ignoredEvents = 0;
  server.watcher.on('all', (_event, file) => {
    if (
      ignoredDirectories.some((name) =>
        path.resolve(file).startsWith(path.join(directory, name) + path.sep),
      )
    ) {
      ignoredEvents++;
    }
  });
  for (const name of ignoredDirectories) {
    await writeFile(path.join(directory, name, 'probe.txt'), 'updated');
  }
  await writeFile(moduleFile, moduleSource('updated'));
  const [exitCode] = await closed;
  assert.equal(exitCode, 0, output);
  const result = JSON.parse(await readFile(resultFile, 'utf8'));
  assert.equal(result.text.trim(), 'Development connection verified');
  assert.equal(result.value, 'updated', 'Source edit did not reach Electron through HMR');
  assert.equal(ignoredEvents, 0);
  console.log(
    'PASS: IPv4 Forge URL, source HMR, development watch exclusions, and Tailwind source scope.',
  );
} finally {
  if (child && child.exitCode === null) {
    const closed = once(child, 'close');
    child.kill();
    await closed;
  }
  await server.close();
  const resolvedDirectory = await realpath(directory);
  assert.equal(path.dirname(resolvedDirectory), temporaryParent);
  assert(path.basename(resolvedDirectory).startsWith('agm-vite-connection-'));
  await rm(resolvedDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
