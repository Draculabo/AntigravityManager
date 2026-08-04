import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  extractOpenCodeVersion,
  findInPath,
} from '@/modules/proxy-gateway/opencode-sync/opencode-installation';

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'antigravity-opencode-path-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('OpenCode installation detection', () => {
  it('extracts a semantic version from CLI output', () => {
    expect(extractOpenCodeVersion('opencode v1.2.3\n')).toBe('1.2.3');
    expect(extractOpenCodeVersion('opencode/0.9.7')).toBe('0.9.7');
    expect(extractOpenCodeVersion('0.9.7-beta.1')).toBe('0.9.7');
  });

  it('returns the unknown fallback for a custom version format', () => {
    expect(extractOpenCodeVersion('\nOpenCode nightly-2026-08-03\n')).toBe('unknown');
    expect(extractOpenCodeVersion('   ')).toBe('unknown');
  });

  it('returns the first Windows PATH match using the extension order', async () => {
    const firstDirectory = await createTemporaryDirectory();
    const secondDirectory = await createTemporaryDirectory();
    await writeFile(join(firstDirectory, 'opencode.cmd'), '');
    await writeFile(join(secondDirectory, 'opencode.exe'), '');

    await expect(
      findInPath('opencode', 'win32', `${firstDirectory};${secondDirectory}`),
    ).resolves.toBe(join(firstDirectory, 'opencode.cmd'));
  });

  it('checks Windows executable extensions in exe, cmd, bat order', async () => {
    const directory = await createTemporaryDirectory();
    await Promise.all([
      writeFile(join(directory, 'opencode.bat'), ''),
      writeFile(join(directory, 'opencode.cmd'), ''),
      writeFile(join(directory, 'opencode.exe'), ''),
    ]);

    await expect(findInPath('opencode', 'win32', directory)).resolves.toBe(
      join(directory, 'opencode.exe'),
    );
  });

  it('returns null when PATH contains no matching executable', async () => {
    const directory = await createTemporaryDirectory();

    await expect(findInPath('opencode', 'linux', directory)).resolves.toBeNull();
  });
});
