import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { prepareWindowsUpdateFeed } from '../../../scripts/prepare-windows-update-feed.mjs';

function writeTextFile(filePath: string, content: string) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('prepareWindowsUpdateFeed', () => {
  it('writes per-arch RELEASES files that point to GitHub Release package assets', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'agm-update-feed-'));
    directories.push(rootDir);
    const sourceDir = path.join(rootDir, 'release-assets');
    const outputDir = path.join(rootDir, 'windows-update-feed');

    writeTextFile(
      path.join(sourceDir, 'squirrel.windows/x64/RELEASES'),
      '\ufeffd7b597ce68a0bcbfd6413eaceda20a097a50fc26 antigravity_manager-0.17.1-full.nupkg 123\n',
    );
    writeTextFile(
      path.join(sourceDir, 'squirrel.windows/x64/antigravity_manager-0.17.1-full.nupkg'),
      'x64 package',
    );
    writeTextFile(
      path.join(sourceDir, 'squirrel.windows/arm64/RELEASES'),
      'e4d909c290d0fb1ca068ffaddf22cbd0de474d54 antigravity_manager-0.17.1-arm64-full.nupkg 123\n',
    );
    writeTextFile(
      path.join(sourceDir, 'squirrel.windows/arm64/antigravity_manager-0.17.1-arm64-full.nupkg'),
      'arm64 package',
    );
    for (const arch of ['x64', 'arm64']) {
      const installer = `antigravity-manager-0.17.1-windows-${arch}-nsis.exe`;
      const content = `${arch} synthetic installer`;
      writeTextFile(path.join(sourceDir, 'nsis', arch, installer), content);
      writeTextFile(
        path.join(sourceDir, 'nsis', arch, `latest-nsis-${arch}.yml`),
        YAML.stringify({
          version: '0.17.1',
          files: [
            {
              url: installer,
              sha512: createHash('sha512').update(content).digest('base64'),
              size: Buffer.byteLength(content),
            },
          ],
          path: installer,
        }),
      );
    }

    const result = prepareWindowsUpdateFeed({
      releaseTag: 'v0.17.1',
      repository: 'Draculabo/AntigravityManager',
      sourceDir,
      outputDir,
    });

    expect(result).toEqual({
      x64: {
        releases: path.join(outputDir, 'win32/x64/RELEASES'),
        packages: ['antigravity_manager-0.17.1-full.nupkg'],
        nsis: path.join(outputDir, 'nsis/win32/x64/latest.yml'),
      },
      arm64: {
        releases: path.join(outputDir, 'win32/arm64/RELEASES'),
        packages: ['antigravity_manager-0.17.1-arm64-full.nupkg'],
        nsis: path.join(outputDir, 'nsis/win32/arm64/latest.yml'),
      },
    });
    expect(existsSync(path.join(outputDir, 'win32/x64/RELEASES'))).toBe(true);
    expect(existsSync(path.join(outputDir, 'win32/arm64/RELEASES'))).toBe(true);
    expect(
      existsSync(path.join(outputDir, 'win32/x64/antigravity_manager-0.17.1-full.nupkg')),
    ).toBe(false);
    expect(readFileSync(path.join(outputDir, 'win32/arm64/RELEASES'), 'utf8')).toContain(
      'https://github.com/Draculabo/AntigravityManager/releases/download/v0.17.1/antigravity_manager-0.17.1-arm64-full.nupkg',
    );
    expect(readFileSync(path.join(outputDir, 'win32/x64/RELEASES'), 'utf8')).toContain(
      'd7b597ce68a0bcbfd6413eaceda20a097a50fc26 https://github.com/Draculabo/AntigravityManager/releases/download/v0.17.1/antigravity_manager-0.17.1-full.nupkg 123',
    );
    for (const arch of ['x64', 'arm64']) {
      const installer = `antigravity-manager-0.17.1-windows-${arch}-nsis.exe`;
      const url = `https://github.com/Draculabo/AntigravityManager/releases/download/v0.17.1/${installer}`;
      expect(
        YAML.parse(readFileSync(path.join(outputDir, 'nsis', 'win32', arch, 'latest.yml'), 'utf8')),
      ).toEqual({
        version: '0.17.1',
        files: [
          {
            url,
            sha512: createHash('sha512').update(`${arch} synthetic installer`).digest('base64'),
            size: Buffer.byteLength(`${arch} synthetic installer`),
          },
        ],
        path: url,
      });
    }
  });
});
