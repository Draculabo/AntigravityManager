import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  createBuildSourceManifest,
  readBuildSourceManifest,
  sha256,
  validateReleaseAssetMatrix,
  validateBuildSourceManifests,
  writeBuildSourceManifest,
} from './build-source-manifest.mjs';

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
  assert.equal(validateReleaseAssetMatrix([manifest]), true);
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
