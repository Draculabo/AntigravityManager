import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import spawn from 'cross-spawn';
import { createServer, loadConfigFromFile } from 'vite';

const require = createRequire(import.meta.url);
const { getConfig } = require('@electron-forge/plugin-vite/dist/config/vite.renderer.config.js');
const { getBuildDefine } = require('@electron-forge/plugin-vite/dist/config/vite.base.config.js');
const loaded = await loadConfigFromFile(
  { command: 'serve', mode: 'development' },
  path.resolve('vite.renderer.config.mts'),
);
assert.equal(loaded?.config.server?.host, '127.0.0.1');

await mkdir('out', { recursive: true });
const temporaryParent = await realpath('out');
const directory = await mkdtemp(path.join(temporaryParent, 'agm-vite-connection-'));
const rendererName = 'main_window';
const config = getConfig(
  { root: directory, mode: 'development', forgeConfigSelf: { name: rendererName } },
  {
    server: { ...loaded.config.server, port: 5173, watch: { ignored: ['**/profile/**'] } },
    logLevel: 'error',
  },
);
const server = await createServer({ ...config, configFile: false });
let child;
try {
  await writeFile(path.join(directory, 'index.html'), '<h1>Development connection verified</h1>');
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
    writeFileSync(process.argv[3], JSON.stringify({ text }));
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
    [entry, String(address.port), resultFile, `--user-data-dir=${path.join(directory, 'profile')}`],
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
  const [exitCode] = await once(child, 'close');
  assert.equal(exitCode, 0, output);
  const result = JSON.parse(await readFile(resultFile, 'utf8'));
  assert.equal(result.text.trim(), 'Development connection verified');
  console.log('PASS: Electron loads the Forge URL through the IPv4 Vite listener.');
} finally {
  child?.kill();
  await server.close();
  const resolvedDirectory = await realpath(directory);
  assert.equal(path.dirname(resolvedDirectory), temporaryParent);
  assert(path.basename(resolvedDirectory).startsWith('agm-vite-connection-'));
  await rm(resolvedDirectory, { recursive: true, force: true });
}
