import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createBuildSourceManifest,
  readBuildSourceManifest,
  sha256,
  validateReleaseAssetMatrix,
  validateBuildSourceManifests,
  writeBuildSourceManifest,
} from './build-source-manifest.mjs';
import { git, resolveHead } from './release-source.mjs';

const artifact = (name) => ({
  name,
  size: 10,
  sha256: sha256(Buffer.from(name)),
});

test('creates and round-trips a source manifest without credentials', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agm-source-manifest-'));
  try {
    const manifest = createBuildSourceManifest({
      sourceSha: 'a'.repeat(40),
      version: '0.25.2',
      platform: 'win32',
      arch: 'x64',
      artifacts: [artifact('Antigravity-Manager-win32-x64-setup.exe')],
    });
    const file = path.join(directory, 'manifest.json');
    await writeBuildSourceManifest(file, manifest);
    assert.deepEqual(await readBuildSourceManifest(file), manifest);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects source and version drift across platform manifests', () => {
  const base = {
    sourceSha: 'a'.repeat(40),
    version: '0.25.2',
    platform: 'win32',
    arch: 'x64',
    artifacts: [artifact('setup.exe')],
  };
  const first = createBuildSourceManifest(base);
  const second = createBuildSourceManifest({
    ...base,
    platform: 'linux',
    arch: 'x64',
    artifacts: [artifact('app.AppImage')],
  });
  assert.deepEqual(validateBuildSourceManifests([first, second]), {
    sourceSha: 'a'.repeat(40),
    version: '0.25.2',
    manifestCount: 2,
    artifactCount: 2,
  });
  assert.throws(
    () => validateBuildSourceManifests([first, { ...second, sourceSha: 'b'.repeat(40) }]),
    /Build source mismatch/,
  );
  assert.throws(
    () => validateBuildSourceManifests([first, { ...second, version: '0.25.3' }]),
    /Build version mismatch/,
  );
});

test('rejects duplicate artifacts and malformed checksums', () => {
  const base = {
    sourceSha: 'a'.repeat(40),
    version: '0.25.2',
    platform: 'win32',
    arch: 'x64',
    artifacts: [artifact('setup.exe')],
  };
  const first = createBuildSourceManifest(base);
  assert.throws(() => validateBuildSourceManifests([first, first]), /Duplicate release artifact/);
  assert.throws(
    () => createBuildSourceManifest({ ...base, artifacts: [{ ...artifact('x'), sha256: 'bad' }] }),
    /Invalid artifact checksum/,
  );
});

test('requires the configured asset formats for every platform', () => {
  const names = [
    'app-win32-x64-setup.exe',
    'app.nupkg',
    'app-windows-x64-nsis.exe',
    'latest-nsis-x64.yml',
  ];
  const manifest = createBuildSourceManifest({
    sourceSha: 'a'.repeat(40),
    version: '0.25.2',
    platform: 'win32',
    arch: 'x64',
    artifacts: names.map(artifact),
  });
  assert.equal(validateReleaseAssetMatrix([manifest]).artifactCount, 4);
  assert.throws(
    () =>
      validateReleaseAssetMatrix([
        {
          ...manifest,
          artifacts: manifest.artifacts.filter((item) => !item.name.endsWith('.nupkg')),
        },
      ]),
    /Missing Squirrel package/,
  );
});

test('the release CLI binds all six manifests to the checkout and the exact tag commit', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agm-release-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Release fixture']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['config', 'tag.gpgSign', 'false']);
  await writeFile(path.join(root, 'package.json'), '{"version":"0.25.2"}\n');
  git(root, ['add', 'package.json']);
  git(root, ['commit', '-qm', 'release source']);
  const releaseSha = resolveHead(root, 'HEAD');
  git(root, ['tag', '-a', 'v0.25.2', '-m', 'release source']);
  git(root, ['tag', 'v0.25.3']);
  git(root, ['commit', '--allow-empty', '-qm', 'main advanced at the same package version']);
  const nextSha = resolveHead(root, 'HEAD');

  const directory = path.join(root, 'assets');
  await mkdir(directory);
  const names = {
    win32: (arch) => [
      `app-win32-${arch}-setup.exe`,
      'app.nupkg',
      `app-windows-${arch}-nsis.exe`,
      `latest-nsis-${arch}.yml`,
    ],
    darwin: () => ['app.dmg', 'app.zip'],
    linux: () => ['app.AppImage', 'app.deb', 'app.rpm'],
  };
  async function writeManifests(sourceSha, version) {
    for (const [platform, assetNames] of Object.entries(names)) {
      for (const arch of ['x64', 'arm64']) {
        await writeBuildSourceManifest(
          path.join(directory, `build-source-${platform}-${arch}.json`),
          createBuildSourceManifest({
            sourceSha,
            version,
            platform,
            arch,
            artifacts: assetNames(arch).map(artifact),
          }),
        );
      }
    }
  }
  const entry = fileURLToPath(new URL('./build-source-manifest.mjs', import.meta.url));
  function run(...options) {
    return spawnSync(
      process.execPath,
      [entry, '--root', root, '--validate-directory', directory, ...options],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 16_384, windowsHide: true },
    );
  }

  await writeManifests(releaseSha, '0.25.2');
  const staleCheckout = run();
  assert.equal(staleCheckout.status, 1, staleCheckout.stderr);
  assert.match(staleCheckout.stderr, /Build source .* does not match checked-out commit/);
  const verifiedFromToolsCheckout = run('--source-sha', releaseSha, '--version', '0.25.2');
  assert.equal(verifiedFromToolsCheckout.status, 0, verifiedFromToolsCheckout.stderr);
  assert.equal(run('--source-sha', releaseSha, '--version', '0.25.3').status, 1);

  await writeManifests(nextSha, '0.25.2');
  const wrongTagCommit = run('--release-tag', 'v0.25.2');
  assert.equal(wrongTagCommit.status, 1, wrongTagCommit.stderr);
  assert.match(wrongTagCommit.stderr, /Release tag v0\.25\.2 points to .* expected/);

  git(root, ['checkout', '--detach', releaseSha]);
  await writeManifests(releaseSha, '0.25.2');
  const valid = run('--release-tag', 'v0.25.2');
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual(JSON.parse(valid.stdout), {
    sourceSha: releaseSha,
    version: '0.25.2',
    manifestCount: 6,
    artifactCount: 18,
  });

  const wrongTagVersion = run('--release-tag', 'v0.25.3');
  assert.equal(wrongTagVersion.status, 1, wrongTagVersion.stderr);
  assert.match(wrongTagVersion.stderr, /Release tag v0\.25\.3 does not match package version/);

  git(root, ['tag', '-d', 'v0.25.2']);
  const missingTag = run('--release-tag', 'v0.25.2');
  assert.equal(missingTag.status, 1, missingTag.stderr);
  assert.match(missingTag.stderr, /Release tag v0\.25\.2 could not be resolved to a commit/);
  assert.equal(run().status, 0, 'A dry run can validate builds before the tag exists');

  await writeManifests(releaseSha, '0.25.3');
  const wrongManifestVersion = run();
  assert.equal(wrongManifestVersion.status, 1, wrongManifestVersion.stderr);
  assert.match(
    wrongManifestVersion.stderr,
    /Build version 0\.25\.3 does not match package version/,
  );

  await writeManifests(releaseSha, '0.25.2');
  await rm(path.join(directory, 'build-source-darwin-arm64.json'));
  const missingTarget = run();
  assert.equal(missingTarget.status, 1, missingTarget.stderr);
  assert.match(
    missingTarget.stderr,
    /Expected one build source manifest for each of the six targets/,
  );
});
