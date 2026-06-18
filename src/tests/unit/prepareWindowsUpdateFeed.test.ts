import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { prepareWindowsUpdateFeed } from '../../../scripts/prepare-windows-update-feed.mjs';

function writeTextFile(filePath: string, content: string) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

describe('prepareWindowsUpdateFeed', () => {
  it('writes per-arch RELEASES files that point to GitHub Release package assets', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'agm-update-feed-'));
    const sourceDir = path.join(rootDir, 'release-assets');
    const outputDir = path.join(rootDir, 'windows-update-feed');

    writeTextFile(
      path.join(sourceDir, 'squirrel.windows/x64/RELEASES'),
      'd7b597ce68a0bcbfd6413eaceda20a097a50fc26 antigravity_manager-0.17.1-full.nupkg 123\n',
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
      },
      arm64: {
        releases: path.join(outputDir, 'win32/arm64/RELEASES'),
        packages: ['antigravity_manager-0.17.1-arm64-full.nupkg'],
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
  });
});
