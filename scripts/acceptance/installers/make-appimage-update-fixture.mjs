import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createPackageWithOptions, extractAll, extractFile, uncache } from '@electron/asar';
import semver from 'semver';

assert.equal(process.platform, 'linux', 'Build AppImage fixtures on Linux');
assert(['x64', 'arm64'].includes(process.arch));
assert.equal(
  process.argv.length,
  5,
  'Supply the current Linux packaged app, an unused directory under out, and a lower version',
);
const project = await realpath(process.cwd());
const outRoot = await realpath(path.join(project, 'out'));
const packaged = await realpath(process.argv[2]);
const output = path.resolve(process.argv[3]);
const previousVersion = semver.valid(process.argv[4]);
assert(previousVersion, 'Fixture version must be valid semver');
assert(packaged.startsWith(`${outRoot}${path.sep}`));
assert(output.startsWith(`${outRoot}${path.sep}`));
assert(!output.startsWith(`${packaged}${path.sep}`));
const outputParent = await realpath(path.dirname(output));
assert(outputParent === outRoot || outputParent.startsWith(`${outRoot}${path.sep}`));
const current = JSON.parse(extractFile(path.join(packaged, 'resources/app.asar'), 'package.json'));
assert(
  semver.lt(previousVersion, current.version),
  'Fixture version must be lower than the payload',
);
await mkdir(output);
assert.equal(await realpath(output), output);
const copied = path.join(output, 'packaged');
await cp(packaged, copied, { recursive: true });
const archive = path.join(copied, 'resources/app.asar');
const temporary = await mkdtemp(path.join(output, 'asar-'));
try {
  extractAll(archive, temporary);
  const file = path.join(temporary, 'package.json');
  const metadata = JSON.parse(await readFile(file, 'utf8'));
  metadata.version = previousVersion;
  await writeFile(file, `${JSON.stringify(metadata, null, 2)}\n`);
  await rm(archive);
  await rm(`${archive}.unpacked`, { recursive: true, force: true });
  await createPackageWithOptions(temporary, archive, {
    unpack: '**/{better-sqlite3,keytar}/**/*',
  });
  uncache(archive);
  assert.equal(JSON.parse(extractFile(archive, 'package.json')).version, previousVersion);
} finally {
  assert.equal(path.dirname(await realpath(temporary)), output);
  await rm(temporary, { recursive: true, force: true });
}
const installer = path.join(output, 'installer');
const configuration = path.join(output, 'fixture-builder.json');
await writeFile(
  configuration,
  JSON.stringify(
    {
      appId: 'com.draculabo.antigravity-manager',
      productName: 'Antigravity Manager',
      executableName: 'antigravity-manager',
      extraMetadata: { version: previousVersion },
      directories: { output: installer },
      linux: { category: 'Utility', icon: path.join(project, 'images/icon.png') },
      artifactName: 'Antigravity.Manager-${version}-linux-${arch}.AppImage',
      publish: null,
    },
    null,
    2,
  ),
);
const result = spawnSync(
  process.execPath,
  [
    path.join(project, 'node_modules/electron-builder/out/cli/cli.js'),
    '--linux',
    'AppImage',
    `--${process.arch}`,
    '--prepackaged',
    copied,
    '--config',
    configuration,
    '--publish',
    'never',
  ],
  { cwd: project, encoding: 'utf8', timeout: 900_000, maxBuffer: 1024 * 1024 },
);
process.stdout.write((result.stdout ?? '').slice(-4000));
process.stderr.write((result.stderr ?? '').slice(-4000));
assert.ifError(result.error);
assert.equal(result.status, 0);
console.log(`Previous-version AppImage fixture ${previousVersion}: ${installer}`);
