// @vitest-environment node
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ProcessInfo } from '@draculabo/sysinfo-process-enhanced';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmIdeAccountIdentity } from '@/modules/antigravity-runtime/ideAccountIdentity';
import { switchContext } from '../support/runtime-switch-fixture';

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
const originalPlatform = process.platform;
vi.mock('@/shared/platform/nativeProcessQuery', () => ({ readNativeProcessSnapshot: mocks.read }));

const root: ProcessInfo = {
  pid: 10,
  parentPid: 1,
  name: 'Antigravity IDE.exe',
  exe: 'C:/fixture/ide.exe',
  startTime: 100n,
  cmd: [],
};
const context = { ...switchContext, target: 'ide' as const, executablePath: root.exe! };
let server: http.Server;
let port: number;
let auth: unknown;
let user: unknown;
let headersValid: boolean;
let requests: string[];
let home: string;

function writeDiscovery(contents: unknown): void {
  const directory = path.join(home, '.gemini', 'antigravity', 'daemon');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `hub_${port}.json`), JSON.stringify(contents));
}
/** CLI 1.5.2+ receives its CSRF token through the environment, not argv. */
function envTokenHub(overrides: Partial<ProcessInfo> = {}): ProcessInfo {
  const base = hub(overrides);
  return {
    ...base,
    cmd: base.cmd.filter((value) => value !== '--csrf_token' && value !== 'synthetic-csrf'),
  };
}

function hub(overrides: Partial<ProcessInfo> = {}): ProcessInfo {
  const name = process.platform === 'win32' ? 'agy.exe' : 'agy';
  return {
    pid: 12,
    parentPid: 11,
    name,
    exe: `C:/fixture/home/.gemini/bin/${name}`,
    startTime: 102n,
    cmd: [
      name,
      '--hub',
      `--hub-port=${port}`,
      '--csrf_token',
      'synthetic-csrf',
      '--app_data_dir=antigravity',
    ],
    ...overrides,
  };
}
const host: ProcessInfo = {
  pid: 11,
  parentPid: root.pid,
  name: 'extension-host',
  exe: root.exe,
  startTime: 101n,
  cmd: [],
};

beforeEach(async () => {
  auth = { authResult: { hasValidAuth: true } };
  user = { userStatus: { email: 'TARGET@example.org', extraProviderField: true } };
  requests = [];
  headersValid = true;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ide-identity-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  server = http.createServer((request, response) => {
    requests.push(request.url ?? '');
    headersValid &&=
      request.method === 'POST' && request.headers['x-codeium-csrf-token'] === 'synthetic-csrf';
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url?.endsWith('GetAuthStatus') ? auth : user));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  mocks.read.mockReset().mockImplementation(async () => [root, host, hub()]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe('IDE Agent identity confirmation', () => {
  it.each(['win32', 'linux', 'darwin'])(
    'confirms %s Agent identity through the launched IDE descendant only',
    async (platform) => {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      const selected =
        platform === 'darwin'
          ? {
              ...context,
              executablePath: '/Applications/Antigravity IDE.app/Contents/MacOS/Electron',
            }
          : context;
      if (platform === 'darwin') {
        mocks.read.mockResolvedValue([
          { ...root, exe: selected.executablePath, name: 'Electron' },
          { ...host, exe: selected.executablePath },
          hub({ exe: '/Users/fixture/.gemini/bin/agy' }),
        ]);
      }
      await confirmIdeAccountIdentity(selected, root.pid, 'target@example.org', 1500);
      expect(headersValid).toBe(true);
      expect(requests).toEqual([
        '/exa.language_server_pb.LanguageServerService/GetAuthStatus',
        '/exa.language_server_pb.LanguageServerService/GetUserStatus',
      ]);
      expect(mocks.read).toHaveBeenCalledTimes(2);
    },
  );
  it.each([
    [
      'another account',
      { authResult: { hasValidAuth: true } },
      { userStatus: { email: 'other@example.org' } },
    ],
    [
      'expired authentication',
      { authResult: { hasValidAuth: false } },
      { userStatus: { email: 'target@example.org' } },
    ],
    [
      'changed response schema',
      { signedIn: true },
      { userStatus: { email: 'target@example.org' } },
    ],
    ['missing identity', { authResult: { hasValidAuth: true } }, { userStatus: {} }],
  ])(
    'rejects %s without leaking returned provider data',
    async (_label, authResponse, userResponse) => {
      auth = authResponse;
      user = userResponse;
      await expect(
        confirmIdeAccountIdentity(context, root.pid, 'target@example.org', 80),
      ).rejects.toMatchObject({ messageKey: 'process-runtime.switched-identity-unconfirmed' });
    },
  );
  it('waits for the Windows IDE Agent when it starts well after the desktop', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const now = Date.now.bind(Date);
    let elapsed = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + elapsed);
    mocks.read.mockResolvedValueOnce([root, host]).mockImplementation(async () => {
      elapsed = 90_000;
      return [root, host, hub()];
    });

    try {
      await confirmIdeAccountIdentity(context, root.pid, 'target@example.org');
    } finally {
      clock.mockRestore();
    }
  });

  it('does not query a standalone CLI or a different IDE profile', async () => {
    mocks.read.mockResolvedValue([
      root,
      host,
      hub({ parentPid: 999 }),
      hub({ pid: 13, cmd: ['agy.exe'] }),
    ]);
    await expect(
      confirmIdeAccountIdentity(context, root.pid, 'target@example.org', 50),
    ).rejects.toThrow();
    expect(requests).toEqual([]);
  });
  it('does not accept an identity from a hub that retires during confirmation', async () => {
    mocks.read.mockResolvedValueOnce([root, host, hub()]).mockResolvedValue([root, host]);
    await expect(
      confirmIdeAccountIdentity(context, root.pid, 'target@example.org', 80),
    ).rejects.toThrow();
    expect(requests).toHaveLength(2);
  });
  it('does not accept a matching hub when the launched main process has been replaced', async () => {
    mocks.read
      .mockResolvedValueOnce([root, host, hub()])
      .mockResolvedValue([{ ...root, startTime: 500n }, host, hub()]);
    await expect(
      confirmIdeAccountIdentity(context, root.pid, 'target@example.org', 80),
    ).rejects.toThrow();
  });
  it('reads the CSRF token from the hub discovery file when argv omits it', async () => {
    mocks.read.mockImplementation(async () => [root, host, envTokenHub()]);
    writeDiscovery({
      pid: 12,
      httpPort: port,
      httpsPort: 1,
      lsVersion: '2.35.2',
      csrfToken: 'synthetic-csrf',
    });

    await confirmIdeAccountIdentity(context, root.pid, 'target@example.org', 1500);

    expect(headersValid).toBe(true);
    expect(requests).toHaveLength(2);
  });
  it.each([
    [
      'another hub process',
      (hubPort: number) => ({ pid: 99, httpPort: hubPort, csrfToken: 'synthetic-csrf' }),
    ],
    ['another port', () => ({ pid: 12, httpPort: 1, csrfToken: 'synthetic-csrf' })],
    [
      'a changed schema',
      (hubPort: number) => ({ pid: 12, httpPort: hubPort, token: 'synthetic-csrf' }),
    ],
  ])('does not use a discovery file written by %s', async (_label, contents) => {
    mocks.read.mockImplementation(async () => [root, host, envTokenHub()]);
    writeDiscovery(contents(port));

    await expect(
      confirmIdeAccountIdentity(context, root.pid, 'target@example.org', 80),
    ).rejects.toMatchObject({ messageKey: 'process-runtime.switched-identity-unconfirmed' });
    expect(requests).toEqual([]);
  });
  it('fails without waiting for the deadline once the launched main process is replaced', async () => {
    mocks.read
      .mockResolvedValueOnce([root, host])
      .mockResolvedValue([{ ...root, startTime: 500n }, host, hub()]);
    const started = Date.now();

    await expect(
      confirmIdeAccountIdentity(context, root.pid, 'target@example.org', 10_000),
    ).rejects.toMatchObject({ messageKey: 'process-runtime.switched-identity-unconfirmed' });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
