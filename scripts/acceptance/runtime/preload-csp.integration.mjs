import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, Option } from 'commander';
import spawn from 'cross-spawn';
import { build, loadConfigFromFile } from 'vite';

const options = new Command()
  .option('--expect-regression', 'Confirm the unfixed preload fails under the real Electron CSP')
  .addOption(
    new Option('--policy-timing <timing>', 'When the page applies its no-eval policy')
      .choices(['initial', 'after-preload'])
      .default('after-preload'),
  )
  .parse()
  .opts();
const project = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(import.meta.url);
const { getConfig } = require('@electron-forge/plugin-vite/dist/config/vite.preload.config.js');
await mkdir(path.join(project, 'out'), { recursive: true });
const parent = await realpath(path.join(project, 'out'));
const directory = await mkdtemp(path.join(parent, 'agm-preload-csp-'));
const resultPath = path.join(directory, 'result.json');
const previousUploadSetting = process.env.AGM_DISABLE_SENTRY_UPLOAD;
process.env.AGM_DISABLE_SENTRY_UPLOAD = '1';
let child;
let exited = false;
let output = '';
try {
  const loaded = await loadConfigFromFile(
    { command: 'build', mode: 'production' },
    path.join(project, 'vite.preload.config.mts'),
  );
  assert(loaded, 'The production preload configuration must load');
  const config = getConfig(
    {
      root: project,
      command: 'build',
      mode: 'production',
      forgeConfigSelf: { entry: path.join(project, 'src/preload.ts') },
    },
    loaded.config,
  );
  await build({
    ...config,
    configFile: false,
    logLevel: 'error',
    build: { ...config.build, outDir: path.join(directory, 'build') },
  });
  await writeFile(
    path.join(directory, 'index.html'),
    `<!doctype html><html><head>
${options.policyTiming === 'initial' ? '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'">' : ''}
<script src="renderer.js" defer></script></head><body><output id="count">0</output></body></html>`,
  );
  await writeFile(
    path.join(directory, 'renderer.js'),
    `${
      options.policyTiming === 'after-preload'
        ? `const policy = document.createElement('meta');
policy.httpEquiv = 'Content-Security-Policy';
policy.content = "default-src 'none'; script-src 'self'";
document.head.append(policy);`
        : ''
    }
window.receivedEvents = [];
window.unsubscribeTraffic = window.electron.onTrafficAuditEvent((event) => {
  window.receivedEvents.push(event);
  document.getElementById('count').textContent = String(window.receivedEvents.length);
});`,
  );
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.NODE_OPTIONS;
  child = spawn(
    require('electron'),
    [
      fileURLToPath(new URL('./preload-csp.fixture.mjs', import.meta.url)),
      directory,
      resultPath,
      options.policyTiming,
    ],
    { cwd: project, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const closed = once(child, 'close');
  child.once('close', () => {
    exited = true;
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      output = (output + chunk).slice(-4000);
    });
  }
  const [code] = await closed;
  assert.equal(code, 0, output);
  const result = JSON.parse(await readFile(resultPath, 'utf8'));
  assert.equal(result.sandbox, false);
  assert.equal(result.contextIsolation, false);
  assert.equal(result.nodeIntegration, true);
  assert.equal(result.webSecurity, true);
  assert.equal(result.evalBlocked, true);
  const report = path.join(
    parent,
    `preload-csp-${options.expectRegression ? 'baseline' : 'acceptance'}-${options.policyTiming}.json`,
  );
  await writeFile(report, JSON.stringify(result, null, 2));
  if (options.expectRegression) {
    assert(
      result.preloadErrors.length > 0,
      'The baseline must reproduce dynamic compilation errors',
    );
    assert(result.receivedEvents < result.expectedEvents, 'The baseline must lose valid callbacks');
  } else {
    assert.deepEqual(result.preloadErrors, []);
    assert.equal(result.exactEventSequence, true);
    assert.equal(result.visibleCount, String(result.expectedEvents));
    assert.equal(result.invalidEventIgnored, true);
    assert.equal(result.unsubscribeWorks, true);
  }
  console.log(
    JSON.stringify(
      {
        ...result,
        preloadErrors: result.preloadErrors.length,
        mode: options.expectRegression ? 'baseline-reproduced' : 'fixed-accepted',
      },
      null,
      2,
    ),
  );
} finally {
  if (previousUploadSetting === undefined) {
    delete process.env.AGM_DISABLE_SENTRY_UPLOAD;
  } else {
    process.env.AGM_DISABLE_SENTRY_UPLOAD = previousUploadSetting;
  }
  if (child && !exited) {
    child.kill();
    await once(child, 'close');
  }
  const resolved = await realpath(directory);
  assert.equal(path.dirname(resolved), parent);
  assert(path.basename(resolved).startsWith('agm-preload-csp-'));
  await rm(resolved, { recursive: true, force: true });
}
