import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { updateArchReleaseMetadata } from '../../../scripts/update-arch-release.mjs';

const OLD_SHA256 = '22cc1049cb5e6969c672842da61ff9760e361bd2787fbe7a20964f5f86fef4dd';
const NEW_SHA256 = '337b7a21796c1d97660d195296723781adf2daee882e265b4c4d00b1a5194761';

describe('updateArchReleaseMetadata', () => {
  it('updates the version and matching checksum together for a new release', async () => {
    const fixtureDir = await mkdtemp(path.join(tmpdir(), 'agm-arch-release-'));
    const pkgbuildPath = path.join(fixtureDir, 'PKGBUILD');
    const checksumPath = path.join(fixtureDir, 'sha256sums-linux-amd64.txt');
    const initialPkgbuild = [
      'pkgname=antigravity-manager-bin',
      'pkgver=0.18.1',
      'pkgrel=4',
      'source=("https://example.invalid/v${pkgver}/Antigravity.Manager_${pkgver}_amd64.deb")',
      `sha256sums=('${OLD_SHA256}')`,
      '',
    ].join('\n');
    const expectedPkgbuild = [
      'pkgname=antigravity-manager-bin',
      'pkgver=0.19.0',
      'pkgrel=1',
      'source=("https://example.invalid/v${pkgver}/Antigravity.Manager_${pkgver}_amd64.deb")',
      `sha256sums=('${NEW_SHA256}')`,
      '',
    ].join('\n');

    await writeFile(pkgbuildPath, initialPkgbuild);
    await writeFile(
      checksumPath,
      [
        `${OLD_SHA256}  Antigravity.Manager_0.19.0_amd64.AppImage`,
        `${NEW_SHA256}  Antigravity.Manager_0.19.0_amd64.deb`,
        '',
      ].join('\n'),
    );

    const result = updateArchReleaseMetadata({
      version: 'v0.19.0',
      checksumPath,
      pkgbuildPath,
    });

    expect(result).toEqual({
      changed: true,
      pkgrel: 1,
      sha256: NEW_SHA256,
      version: '0.19.0',
    });
    expect(await readFile(pkgbuildPath, 'utf8')).toBe(expectedPkgbuild);
  });

  it('increments pkgrel when a published version receives a different artifact', async () => {
    const fixtureDir = await mkdtemp(path.join(tmpdir(), 'agm-arch-release-'));
    const pkgbuildPath = path.join(fixtureDir, 'PKGBUILD');
    const checksumPath = path.join(fixtureDir, 'sha256sums-linux-amd64.txt');
    const initialPkgbuild = [
      'pkgname=antigravity-manager-bin',
      'pkgver=0.19.0',
      'pkgrel=2',
      'source=("https://example.invalid/v${pkgver}/Antigravity.Manager_${pkgver}_amd64.deb")',
      `sha256sums=('${OLD_SHA256}')`,
      '',
    ].join('\n');
    const expectedPkgbuild = initialPkgbuild
      .replace('pkgrel=2', 'pkgrel=3')
      .replace(OLD_SHA256, NEW_SHA256);

    await writeFile(pkgbuildPath, initialPkgbuild);
    await writeFile(checksumPath, `${NEW_SHA256}  Antigravity.Manager_0.19.0_amd64.deb\n`);

    const result = updateArchReleaseMetadata({
      version: '0.19.0',
      checksumPath,
      pkgbuildPath,
    });

    expect(result).toEqual({
      changed: true,
      pkgrel: 3,
      sha256: NEW_SHA256,
      version: '0.19.0',
    });
    expect(await readFile(pkgbuildPath, 'utf8')).toBe(expectedPkgbuild);
  });
});
