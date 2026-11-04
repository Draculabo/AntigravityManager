// @vitest-environment node
import http from 'node:http';
import type { AddressInfo } from 'node:net';
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
});
