import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeWindowsCredential } from '@/modules/antigravity-runtime/credentials/windowsCredentialStore';
vi.mock('@/modules/antigravity-runtime/credentials/windowsCredentialStore', () => ({
  writeWindowsCredential: vi.fn(async () => {}),
}));
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  createEntry: vi.fn(),
  homeDirectory: vi.fn(),
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
  setSecret: vi.fn(),
  spawnSync: vi.fn(),
  withTarget: vi.fn(),
  writeAgyCliToken: vi.fn(),
  writeGoogleOAuthCredentials: vi.fn(),
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, default: { ...actual, homedir: mocks.homeDirectory } };
});
vi.mock('@/modules/antigravity-runtime/credentials/googleOAuthCredentialStore', () => ({
  writeGoogleOAuthCredentials: mocks.writeGoogleOAuthCredentials,
}));

vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    static withTarget = mocks.withTarget;
    setSecret = mocks.setSecret;
    constructor(service: string, username: string) {
      mocks.createEntry(service, username);
    }
  },
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    default: {
      ...actual,
      execFileSync: vi.fn(),
      spawnSync: mocks.spawnSync,
    },
    execFileSync: vi.fn(),
    spawnSync: mocks.spawnSync,
  };
});
vi.mock('@/modules/antigravity-runtime/credentials/agyCliTokenStore', () => ({
  writeAgyCliToken: mocks.writeAgyCliToken,
}));

vi.mock('@/shared/logging/logger', () => ({
  logger: mocks.logger,
}));

const originalPlatform = process.platform;
let testHome: string | undefined;
const TEST_TOKEN = {
  access_token: 'access-token-for-test',
  expiry_timestamp: 1_700_000_000,
  refresh_token: 'refresh-token-for-test',
};
const LOGIN_STORE_ARGS = [
  'store',
  '--collection=login',
  "--label=Password for 'antigravity' on 'gemini'",
  'service',
  'gemini',
  'username',
  'antigravity',
];
const DEFAULT_STORE_ARGS = [
  'store',
  '--label=gemini',
  'service',
  'gemini',
  'username',
  'antigravity',
];

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });
}

function secretToolResult(status: number, stderr = '') {
  return {
    error: undefined,
    status,
    stderr,
  };
}

function secretToolUnavailable() {
  return {
    error: Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' }),
    status: null,
    stderr: '',
  };
}

function secretToolTimeout() {
  return {
    error: Object.assign(new Error('credential payload must not be logged'), { code: 'ETIMEDOUT' }),
    status: null,
    stderr: '',
  };
}

describe('Linux credential store dual collection writes', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.logger.debug.mockReset();
    mocks.logger.error.mockReset();
    mocks.logger.info.mockReset();
    mocks.logger.warn.mockReset();
    mocks.setSecret.mockReset();
    mocks.createEntry.mockReset();
    mocks.spawnSync.mockReset();
    mocks.withTarget.mockReset();
    mocks.writeAgyCliToken.mockReset();
    mocks.writeGoogleOAuthCredentials.mockReset();
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-classic-token-'));
    mocks.homeDirectory.mockReturnValue(testHome);
    mocks.withTarget.mockReturnValue({
      setSecret: mocks.setSecret,
    });
    setPlatform('linux');
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    if (testHome && path.dirname(testHome) === os.tmpdir()) {
      fs.rmSync(testHome, { force: true, recursive: true });
    }
    testHome = undefined;
  });

  it('initializes and replaces the official standalone credential file for Linux Classic', async () => {
    mocks.spawnSync.mockReturnValue(secretToolUnavailable());
    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/antigravity-runtime/credentials/antigravityCredentialStore');
    const target = path.join(mocks.homeDirectory(), '.gemini', 'jetski-standalone-oauth-token');
    await writeAntigravityCredentialStoreToken(TEST_TOKEN, { syncClassicOAuthFile: true });
    expect(fs.readFileSync(target)).toEqual(mocks.setSecret.mock.calls[0][0]);
    await writeAntigravityCredentialStoreToken(
      { ...TEST_TOKEN, access_token: 'second-account-access-token' },
      { syncClassicOAuthFile: true },
    );
    expect(fs.readFileSync(target)).toEqual(mocks.setSecret.mock.calls[1][0]);
    expect(fs.readdirSync(path.dirname(target))).toEqual(['jetski-standalone-oauth-token']);
    if (originalPlatform === 'linux') {
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    }
  });

  it('does not replace the Classic file for an explicit CLI switch', async () => {
    mocks.spawnSync.mockReturnValue(secretToolUnavailable());
    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/antigravity-runtime/credentials/antigravityCredentialStore');
    const target = path.join(mocks.homeDirectory(), '.gemini', 'jetski-standalone-oauth-token');
    await writeAntigravityCredentialStoreToken(TEST_TOKEN, { syncClassicOAuthFile: true });
    const original = fs.readFileSync(target);
    await writeAntigravityCredentialStoreToken(
      { ...TEST_TOKEN, access_token: 'cli-account-access-token' },
      { syncGoogleOAuthFiles: true, email: 'cli@example.com' },
    );

    expect(fs.readFileSync(target)).toEqual(original);
    expect(mocks.writeGoogleOAuthCredentials).toHaveBeenCalledOnce();
  });

  it('reports a required Classic file write failure instead of accepting only the keyring write', async () => {
    mocks.spawnSync.mockReturnValue(secretToolUnavailable());
    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/antigravity-runtime/credentials/antigravityCredentialStore');
    fs.writeFileSync(path.join(mocks.homeDirectory(), '.gemini'), 'existing non-directory');
    await expect(
      writeAntigravityCredentialStoreToken(TEST_TOKEN, { syncClassicOAuthFile: true }),
    ).rejects.toThrow();
    expect(mocks.writeAgyCliToken).not.toHaveBeenCalled();
  });

  it('keeps Windows Classic on its existing credential-store path', async () => {
    setPlatform('win32');
    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/antigravity-runtime/credentials/antigravityCredentialStore');
    await writeAntigravityCredentialStoreToken(TEST_TOKEN, { syncClassicOAuthFile: true });
    expect(writeWindowsCredential).toHaveBeenCalledWith(
      'gemini:antigravity',
      'antigravity',
      expect.any(String),
    );
    expect(mocks.setSecret).not.toHaveBeenCalled();
    expect(fs.readdirSync(mocks.homeDirectory())).toEqual([]);
  });

  it('synchronizes login and default collections when secret-tool is available', async () => {
    mocks.spawnSync
      .mockReturnValueOnce(secretToolResult(0))
      .mockReturnValueOnce(secretToolResult(0))
      .mockReturnValueOnce(secretToolResult(0));
    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/antigravity-runtime/credentials/antigravityCredentialStore');
    await writeAntigravityCredentialStoreToken(TEST_TOKEN);
    expect(mocks.spawnSync).toHaveBeenNthCalledWith(1, 'secret-tool', [], {
      stdio: 'ignore',
      timeout: 3000,
    });
    expect(mocks.spawnSync).toHaveBeenNthCalledWith(
      2,
      'secret-tool',
      LOGIN_STORE_ARGS,
      expect.objectContaining({
        encoding: 'utf-8',
        input: expect.stringContaining('"refresh_token":"refresh-token-for-test"'),
        timeout: 10_000,
      }),
    );
    expect(mocks.spawnSync).toHaveBeenNthCalledWith(
      3,
      'secret-tool',
      DEFAULT_STORE_ARGS,
      expect.objectContaining({
        encoding: 'utf-8',
        input: expect.stringContaining('"refresh_token":"refresh-token-for-test"'),
        timeout: 10_000,
      }),
    );
    expect(mocks.setSecret).not.toHaveBeenCalled();
  });

  it('preserves the default collection when the login collection write fails', async () => {
    mocks.spawnSync
      .mockReturnValueOnce(secretToolResult(0))
      .mockReturnValueOnce(secretToolResult(1, 'login unavailable'))
      .mockReturnValueOnce(secretToolResult(0));
    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/antigravity-runtime/credentials/antigravityCredentialStore');
    await writeAntigravityCredentialStoreToken(TEST_TOKEN);
    expect(mocks.spawnSync).toHaveBeenCalledTimes(3);
    expect(mocks.spawnSync.mock.calls[2]?.[1]).toEqual(DEFAULT_STORE_ARGS);
    expect(mocks.setSecret).not.toHaveBeenCalled();
  });

  it('falls back to the native keyring when the default collection write fails', async () => {
    mocks.spawnSync
      .mockReturnValueOnce(secretToolResult(0))
      .mockReturnValueOnce(secretToolResult(0))
      .mockReturnValueOnce(secretToolResult(1, 'default unavailable'));
    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/antigravity-runtime/credentials/antigravityCredentialStore');
    await writeAntigravityCredentialStoreToken(TEST_TOKEN);
    expect(mocks.spawnSync).toHaveBeenCalledTimes(3);
    expect(mocks.spawnSync.mock.calls[1]?.[1]).toEqual(LOGIN_STORE_ARGS);
    expect(mocks.spawnSync.mock.calls[2]?.[1]).toEqual(DEFAULT_STORE_ARGS);
    expect(mocks.setSecret).toHaveBeenCalledWith(expect.any(Buffer));
  });

  it('falls back to the native keyring after both collection writes fail', async () => {
    mocks.spawnSync
      .mockReturnValueOnce(secretToolResult(0))
      .mockReturnValueOnce(secretToolResult(1, 'login unavailable'))
      .mockReturnValueOnce(secretToolResult(1, 'default unavailable'));
    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/antigravity-runtime/credentials/antigravityCredentialStore');
    await writeAntigravityCredentialStoreToken(TEST_TOKEN);
    expect(mocks.spawnSync).toHaveBeenCalledTimes(3);
    expect(mocks.setSecret).toHaveBeenCalledWith(expect.any(Buffer));
  });

  it('falls back to the native keyring when secret-tool is unavailable', async () => {
    mocks.spawnSync.mockReturnValueOnce(secretToolUnavailable());
    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/antigravity-runtime/credentials/antigravityCredentialStore');
    await writeAntigravityCredentialStoreToken(TEST_TOKEN);
    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
    expect(mocks.createEntry).toHaveBeenCalledWith('gemini', 'antigravity');
    expect(mocks.withTarget).not.toHaveBeenCalled();
    expect(mocks.setSecret).toHaveBeenCalledWith(expect.any(Buffer));
  });

  it('does not log the transport error when collection writes time out', async () => {
    mocks.spawnSync
      .mockReturnValueOnce(secretToolResult(0))
      .mockReturnValueOnce(secretToolTimeout())
      .mockReturnValueOnce(secretToolTimeout());
    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/antigravity-runtime/credentials/antigravityCredentialStore');
    await writeAntigravityCredentialStoreToken(TEST_TOKEN);
    expect(mocks.spawnSync).toHaveBeenCalledTimes(3);
    expect(mocks.setSecret).toHaveBeenCalledWith(expect.any(Buffer));
    expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain(
      'credential payload must not be logged',
    );
  });
});
