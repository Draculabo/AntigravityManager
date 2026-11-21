import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pruneLinuxSqlitePrebuilds } from '@/shared/packaging/linuxSqlitePrebuilds';

const prebuildFiles = [
  'darwin-arm64.node',
  'linux-arm64.node',
  'linux-x64.node',
  'linuxmusl-arm64.node',
  'linuxmusl-x64.node',
  'win32-x64.node',
];

describe('Linux desktop SQLite prebuild staging', () => {
  it.for(['x64', 'arm64'])(
    'keeps only the glibc binary for %s',
    async (arch, { onTestFinished }) => {
      const root = await mkdtemp(path.join(tmpdir(), 'agm-sqlite-prebuilds-'));
      onTestFinished(() => rm(root, { recursive: true, force: true }));
      const stagedModule = path.join(root, 'better-sqlite3');
      const prebuilds = path.join(stagedModule, 'prebuilds');
      await mkdir(prebuilds, { recursive: true });
      await Promise.all(prebuildFiles.map((name) => writeFile(path.join(prebuilds, name), name)));
      await writeFile(path.join(stagedModule, 'LICENSE'), 'license text');

      pruneLinuxSqlitePrebuilds(stagedModule, arch);

      const target = `linux-${arch}.node`;
      expect(await readdir(prebuilds)).toEqual([target]);
      expect(await readFile(path.join(prebuilds, target), 'utf8')).toBe(target);
      expect(await readFile(path.join(stagedModule, 'LICENSE'), 'utf8')).toBe('license text');
    },
  );

  it('fails before modifying staging when the expected binary is absent', async ({
    onTestFinished,
  }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'agm-sqlite-prebuilds-'));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const stagedModule = path.join(root, 'better-sqlite3');
    const prebuilds = path.join(stagedModule, 'prebuilds');
    await mkdir(prebuilds, { recursive: true });
    await writeFile(path.join(prebuilds, 'linuxmusl-arm64.node'), 'musl');

    expect(() => pruneLinuxSqlitePrebuilds(stagedModule, 'arm64')).toThrow(
      `Missing staged better-sqlite3 prebuild: ${path.join(prebuilds, 'linux-arm64.node')}`,
    );
    expect(await readdir(prebuilds)).toEqual(['linuxmusl-arm64.node']);
  });
});
