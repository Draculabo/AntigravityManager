// @vitest-environment node
import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  findLatestSquirrelVersion,
  readSquirrelReleases,
} from '@/modules/app-shell/update/windowsSquirrelFeed';
import {
  getWindowsSquirrelVersion,
  isWindowsSquirrelInstall,
} from '@/modules/app-shell/update/windowsSquirrelInstall';

const hash = 'a'.repeat(40);

describe('Windows Squirrel update boundaries', () => {
  it('recognizes only the versioned Squirrel install contract', () => {
    const updatePath = 'C:\\Users\\Test\\AppData\\Local\\antigravity_manager\\Update.exe';
    const installed =
      'C:\\Users\\Test\\AppData\\Local\\antigravity_manager\\app-0.19.0\\antigravity-manager.exe';
    const updateExists = (file: string) => file === updatePath;

    expect(isWindowsSquirrelInstall(installed, updateExists)).toBe(true);
    expect(getWindowsSquirrelVersion(installed)).toBe('0.19.0');
    expect(
      isWindowsSquirrelInstall(
        'C:\\Program Files\\Antigravity Manager\\antigravity-manager.exe',
        updateExists,
      ),
    ).toBe(false);
    expect(
      isWindowsSquirrelInstall(
        'C:\\Users\\Test\\AppData\\Local\\other_app\\app-0.19.0\\antigravity-manager.exe',
        updateExists,
      ),
    ).toBe(false);
    expect(isWindowsSquirrelInstall(installed, () => false)).toBe(false);
  });

  it('selects the newest matching stable full package for the current architecture', () => {
    const releases = [
      `${hash} antigravity_manager-0.21.1-full.nupkg 190330162`,
      `${hash} https://example.test/antigravity_manager-0.21.2-full.nupkg 190330162`,
      `${hash} antigravity_manager-0.22.0-arm64-full.nupkg 190330162`,
      `${hash} antigravity_manager-0.23.0-delta.nupkg 190330162`,
      `${hash} antigravity_manager-0.24.0-beta.1-full.nupkg 190330162`,
      `bad antigravity_manager-0.25.0-full.nupkg 190330162`,
    ].join('\n');

    expect(findLatestSquirrelVersion(releases, '0.21.0', 'x64')).toBe('0.21.2');
    expect(findLatestSquirrelVersion(releases, '0.21.0', 'arm64')).toBe('0.22.0');
    expect(findLatestSquirrelVersion(releases, '0.21.2', 'x64')).toBe(null);
  });

  it('reads the release index and rejects an oversized response', async () => {
    let content = `${hash} antigravity_manager-0.21.1-full.nupkg 123\n`;
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' }).end(content);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Test server did not bind a TCP port');
      }
      const feedUrl = `http://127.0.0.1:${address.port}/`;
      expect(await readSquirrelReleases(feedUrl)).toBe(content);
      content = 'x'.repeat(64 * 1024 + 1);
      await expect(readSquirrelReleases(feedUrl)).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
