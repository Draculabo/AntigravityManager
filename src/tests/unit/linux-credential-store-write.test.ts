import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
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
}));

vi.mock('@napi-rs/keyring', () => ({
  Entry: {
    withTarget: mocks.withTarget,
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

vi.mock('@/modules/cloud-account/persistence/agyCliTokenStore', () => ({
  writeAgyCliToken: mocks.writeAgyCliToken,
}));

vi.mock('@/shared/logging/logger', () => ({
  logger: mocks.logger,
}));

const originalPlatform = process.platform;
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
    mocks.spawnSync.mockReset();
    mocks.withTarget.mockReset();
    mocks.writeAgyCliToken.mockReset();
    mocks.withTarget.mockReturnValue({
      setSecret: mocks.setSecret,
    });
    setPlatform('linux');
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it('synchronizes login and default collections when secret-tool is available', async () => {
    mocks.spawnSync
      .mockReturnValueOnce(secretToolResult(0))
      .mockReturnValueOnce(secretToolResult(0))
      .mockReturnValueOnce(secretToolResult(0));
    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/cloud-account/persistence/antigravityCredentialStore');

    writeAntigravityCredentialStoreToken(TEST_TOKEN);

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
      await import('@/modules/cloud-account/persistence/antigravityCredentialStore');

    writeAntigravityCredentialStoreToken(TEST_TOKEN);

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
      await import('@/modules/cloud-account/persistence/antigravityCredentialStore');

    writeAntigravityCredentialStoreToken(TEST_TOKEN);

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
      await import('@/modules/cloud-account/persistence/antigravityCredentialStore');

    writeAntigravityCredentialStoreToken(TEST_TOKEN);

    expect(mocks.spawnSync).toHaveBeenCalledTimes(3);
    expect(mocks.setSecret).toHaveBeenCalledWith(expect.any(Buffer));
  });

  it('falls back to the native keyring when secret-tool is unavailable', async () => {
    mocks.spawnSync.mockReturnValueOnce(secretToolUnavailable());
    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/cloud-account/persistence/antigravityCredentialStore');

    writeAntigravityCredentialStoreToken(TEST_TOKEN);

    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
    expect(mocks.setSecret).toHaveBeenCalledWith(expect.any(Buffer));
  });

  it('does not log the transport error when collection writes time out', async () => {
    mocks.spawnSync
      .mockReturnValueOnce(secretToolResult(0))
      .mockReturnValueOnce(secretToolTimeout())
      .mockReturnValueOnce(secretToolTimeout());
    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/cloud-account/persistence/antigravityCredentialStore');

    writeAntigravityCredentialStoreToken(TEST_TOKEN);

    expect(mocks.spawnSync).toHaveBeenCalledTimes(3);
    expect(mocks.setSecret).toHaveBeenCalledWith(expect.any(Buffer));
    expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain(
      'credential payload must not be logged',
    );
  });
});
