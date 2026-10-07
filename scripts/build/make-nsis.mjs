import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arch = process.argv[2];
if (arch !== 'x64' && arch !== 'arm64') {
  throw new Error('Usage: npm run make:nsis -- <x64|arm64> [packaged-app]');
}

const packaged = path.resolve(
  projectRoot,
  process.argv[3] || path.join('out', `Antigravity Manager-win32-${arch}`),
);
const resources = path.join(packaged, 'resources');
assert(existsSync(path.join(resources, 'app.asar')), 'Forge packaged app is required first');
assert(
  existsSync(path.join(packaged, 'antigravity-manager.exe')),
  'Packaged executable is missing',
);

const feedUrl = `https://raw.githubusercontent.com/Draculabo/AntigravityManager/release-updates/nsis/win32/${arch}`;
writeFileSync(
  path.join(resources, 'app-update.yml'),
  YAML.stringify({
    provider: 'generic',
    url: feedUrl,
    updaterCacheDirName: 'antigravity-manager-updater',
  }),
);

const output = path.resolve(projectRoot, process.env.AGM_NSIS_OUTPUT || `out/make/nsis/${arch}`);
const builderCli = path.join(
  projectRoot,
  'node_modules',
  'electron-builder',
  'out',
  'cli',
  'cli.js',
);
const run = spawnSync(
  process.execPath,
  [
    builderCli,
    '--win',
    'nsis',
    `--${arch}`,
    '--prepackaged',
    packaged,
    '--config',
    'electron-builder.config.cjs',
    '--publish',
    'never',
  ],
  {
    cwd: projectRoot,
    env: { ...process.env, AGM_NSIS_ARCH: arch },
    stdio: 'inherit',
    windowsHide: true,
  },
);
if (run.error) {
  throw run.error;
}
if (run.status !== 0) {
  throw new Error(`electron-builder failed with status ${run.status}`);
}

const version = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version;
const exeName = `Antigravity.Manager-${version}-windows-${arch}-nsis.exe`;
const exe = path.join(output, exeName);
const metadata = path.join(output, 'latest.yml');
assert(existsSync(exe), `NSIS installer is missing: ${exe}`);
assert(existsSync(metadata), `NSIS metadata is missing: ${metadata}`);

const parsed = YAML.parse(readFileSync(metadata, 'utf8'));
const bytes = readFileSync(exe);
assert.equal(parsed.version, version);
assert.equal(parsed.files?.[0]?.url, exeName);
assert.equal(parsed.files?.[0]?.size, statSync(exe).size);
assert.equal(parsed.files?.[0]?.sha512, createHash('sha512').update(bytes).digest('base64'));

renameSync(metadata, path.join(output, `latest-nsis-${arch}.yml`));
rmSync(path.join(output, 'builder-debug.yml'), { force: true });
console.log(`Verified NSIS installer and update metadata: ${exe}`);
