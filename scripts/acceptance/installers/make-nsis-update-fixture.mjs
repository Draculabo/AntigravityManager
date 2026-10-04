import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  extractAll,
  extractFile,
  createPackageWithOptions,
  getRawHeader,
  uncache,
} from '@electron/asar';

const require = createRequire(import.meta.url);
const { load: loadResourceEditor } = require('resedit/cjs');

assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
assert.equal(
  process.argv.length,
  4,
  'Supply the current packaged app and an unused directory under out',
);

const project = await realpath(process.cwd());
const outRoot = await realpath(path.join(project, 'out'));
const packaged = await realpath(path.resolve(process.argv[2]));
const fixtureRoot = path.resolve(process.argv[3]);
assert(fixtureRoot.startsWith(`${outRoot}${path.sep}`));
await mkdir(fixtureRoot);
assert.equal(await realpath(fixtureRoot), fixtureRoot);

const packageJson = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
const [major, minor, patch] = packageJson.version.split('.').map(Number);
assert([major, minor, patch].every(Number.isSafeInteger) && patch > 0);
const previousVersion = `${major}.${minor}.${patch - 1}`;
const fixture = path.join(fixtureRoot, path.basename(packaged));
await cp(packaged, fixture, { recursive: true });

const temp = await mkdtemp(path.join(fixtureRoot, 'asar-'));
const appAsar = path.join(fixture, 'resources', 'app.asar');
const unpacked = `${appAsar}.unpacked`;
try {
  extractAll(appAsar, temp);
  const metadataFile = path.join(temp, 'package.json');
  const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
  assert.equal(metadata.version, packageJson.version);
  metadata.version = previousVersion;
  await writeFile(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`);
  await rm(appAsar);
  await rm(unpacked, { recursive: true, force: true });
  await createPackageWithOptions(temp, appAsar, {
    unpack: '**/{better-sqlite3,keytar,ps-list}/**/*',
  });
  uncache(appAsar);
  assert.equal(
    JSON.parse(extractFile(appAsar, 'package.json').toString()).version,
    previousVersion,
  );

  // Electron embeds the ASAR header hash in the executable; update only this copied test binary.
  const executable = path.join(fixture, 'antigravity-manager.exe');
  const resourceEditor = await loadResourceEditor();
  const nativeExe = resourceEditor.NtExecutable.from(await readFile(executable));
  const resources = resourceEditor.NtExecutableResource.from(nativeExe);
  const integrityResource = resources.entries.find(
    (entry) => entry.type === 'INTEGRITY' && entry.id === 'ELECTRONASAR',
  );
  assert(integrityResource, 'Copied Electron executable lacks ASAR integrity metadata');
  const integrity = JSON.parse(Buffer.from(integrityResource.bin).toString('utf8'));
  assert.equal(integrity.length, 1);
  assert.equal(integrity[0].file, 'resources\\app.asar');
  assert.equal(integrity[0].alg, 'SHA256');
  integrity[0].value = createHash('sha256')
    .update(getRawHeader(appAsar).headerString)
    .digest('hex');
  integrityResource.bin = Buffer.from(JSON.stringify(integrity), 'utf8');
  resources.outputResource(nativeExe);
  await writeFile(executable, Buffer.from(nativeExe.generate()));
} finally {
  assert.equal(path.dirname(await realpath(temp)), fixtureRoot);
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

const output = path.join(fixtureRoot, 'installer');
const cli = path.join(project, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
const result = spawnSync(
  process.execPath,
  [
    cli,
    '--win',
    'nsis',
    '--x64',
    '--prepackaged',
    fixture,
    '--config',
    'electron-builder.config.cjs',
    `--config.extraMetadata.version=${previousVersion}`,
    '--publish',
    'never',
  ],
  {
    cwd: project,
    env: { ...process.env, AGM_NSIS_ARCH: 'x64', AGM_NSIS_OUTPUT: output },
    windowsHide: true,
    stdio: 'inherit',
  },
);
assert.ifError(result.error);
assert.equal(result.status, 0);
assert(
  (
    await stat(path.join(output, `Antigravity.Manager-${previousVersion}-windows-x64-nsis.exe`))
  ).isFile(),
);
console.log(`Previous NSIS fixture ${previousVersion}: ${output}`);
