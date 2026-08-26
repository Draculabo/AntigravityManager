import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSecret: vi.fn(),
  spawnSync: vi.fn(),
  withTarget: vi.fn(),
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

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });
}

function encodedCredential(refreshToken: string): number[] {
  return Array.from(
    Buffer.from(
      JSON.stringify({
        token: {
          refresh_token: refreshToken,
        },
      }),
      'utf-8',
    ),
  );
}

describe('Linux credential store precedence', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.getSecret.mockReset();
    mocks.spawnSync.mockReset();
    mocks.withTarget.mockReset();
    mocks.withTarget.mockReturnValue({
      getSecret: mocks.getSecret,
    });
    setPlatform('linux');
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it('prefers secret-tool over a stale native keyring credential', async () => {
    mocks.getSecret.mockReturnValue(encodedCredential('refresh-native-stale'));
    mocks.spawnSync.mockReturnValue({
      error: undefined,
      status: 0,
      stdout: JSON.stringify({
        token: {
          refresh_token: 'refresh-secret-tool-current',
        },
      }),
      stderr: '',
    });

    const { readAntigravityCredentialStoreToken } =
      await import('@/modules/cloud-account/persistence/antigravityCredentialStore');

    expect(readAntigravityCredentialStoreToken()).toEqual({
      refreshToken: 'refresh-secret-tool-current',
    });
    expect(mocks.getSecret).not.toHaveBeenCalled();
  });

  it('falls back to native keyring when secret-tool is unavailable', async () => {
    mocks.spawnSync.mockReturnValue({
      error: Object.assign(new Error('spawn secret-tool ENOENT'), {
        code: 'ENOENT',
      }),
      status: null,
      stdout: '',
      stderr: '',
    });
    mocks.getSecret.mockReturnValue(encodedCredential('refresh-native-current'));

    const { readAntigravityCredentialStoreToken } =
      await import('@/modules/cloud-account/persistence/antigravityCredentialStore');

    expect(readAntigravityCredentialStoreToken()).toEqual({
      refreshToken: 'refresh-native-current',
    });
    expect(mocks.getSecret).toHaveBeenCalledTimes(1);
  });
});
