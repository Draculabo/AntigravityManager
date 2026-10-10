import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AppImageUpdater } from 'electron-updater';
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor.js';
import { NodeHttpExecutor } from 'builder-util/out/nodeHttpExecutor.js';
import YAML from 'yaml';

// Use the library's real download/digest pipeline with Node sockets on every development OS.
class LocalHttpExecutor extends NodeHttpExecutor {
  download(...args) {
    return ElectronHttpExecutor.prototype.download.apply(this, args);
  }
}

test('AppImage metadata selection and verified HTTP download', async (t) => {
  const parent = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(parent, 'agm-appimage-download-'));
  const archive = Buffer.alloc(4096, 7);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(archive);
  Buffer.from([0x41, 0x49, 2]).copy(archive, 8);
  const sha512 = createHash('sha512').update(archive).digest('base64');
  const metadata = {
    version: '1.2.3',
    releaseDate: '2026-10-10T00:00:00Z',
    files: [{ url: 'Manager-1.2.3.AppImage', sha512, size: archive.length }],
  };
  let mode = 'valid';
  const requests = [];
  const server = createServer((request, response) => {
    const name = new URL(request.url, 'http://127.0.0.1').pathname;
    requests.push(name);
    if (name.endsWith('.yml')) {
      response.end(YAML.stringify(metadata));
    } else if (name.endsWith('.AppImage')) {
      response.writeHead(200, { 'Content-Length': archive.length });
      if (mode === 'interrupted') {
        response.write(archive.subarray(0, 50));
        setImmediate(() => response.destroy());
      } else {
        response.end(mode === 'tampered' ? Buffer.alloc(archive.length, 9) : archive);
      }
    } else {
      response.writeHead(404).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const feed = `http://127.0.0.1:${server.address().port}`;
  const originalAppImage = process.env.APPIMAGE;
  const originalArch = process.env.TEST_UPDATER_ARCH;
  const originalProxy = process.env.http_proxy;
  delete process.env.http_proxy;
  process.env.APPIMAGE = path.join(directory, 'old.AppImage');
  await writeFile(process.env.APPIMAGE, archive);
  await writeFile(
    path.join(directory, 'unused.yml'),
    YAML.stringify({ updaterCacheDirName: 'appimage-download-check' }),
  );
  try {
    for (const arch of ['x64', 'arm64']) {
      await t.test(`selects ${arch} metadata and rejects corruption and interruption`, async () => {
        process.env.TEST_UPDATER_ARCH = arch;
        for (const scenario of ['tampered', 'interrupted', 'valid']) {
          mode = scenario;
          const location = path.join(directory, `${arch}-${scenario}`);
          const adapter = {
            version: '1.2.2',
            name: 'appimage-download-check',
            isPackaged: true,
            appUpdateConfigPath: path.join(directory, 'unused.yml'),
            userDataPath: location,
            baseCachePath: location,
            whenReady: async () => {},
            relaunch: () => {},
            quit: () => {},
            onQuit: () => assert.fail('Downloads must not arm an automatic installation'),
          };
          const updater = new AppImageUpdater(undefined, adapter);
          updater.httpExecutor = new LocalHttpExecutor();
          updater._testOnlyOptions = { platform: 'linux' };
          updater.logger = { info() {}, warn() {}, error() {}, debug() {} };
          updater.autoDownload = false;
          updater.autoInstallOnAppQuit = false;
          updater.disableDifferentialDownload = true;
          updater.setFeedURL({ provider: 'generic', url: feed });
          const events = [];
          updater.on('update-downloaded', (info) => events.push(info.version));
          assert.equal((await updater.checkForUpdates()).isUpdateAvailable, true);
          if (scenario === 'valid') {
            const [file] = await updater.downloadUpdate();
            assert.deepEqual(await readFile(file), archive);
            assert.deepEqual(events, ['1.2.3']);
          } else {
            await assert.rejects(updater.downloadUpdate());
            assert.deepEqual(events, []);
          }
        }
      });
    }
    assert(requests.includes('/latest-linux.yml'));
    assert(requests.includes('/latest-linux-arm64.yml'));
  } finally {
    for (const [key, value] of Object.entries({
      APPIMAGE: originalAppImage,
      TEST_UPDATER_ARCH: originalArch,
      http_proxy: originalProxy,
    })) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(path.dirname(await realpath(directory)), parent);
    await rm(directory, { recursive: true, force: true });
  }
});
