import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteCredential: vi.fn(),
  setSecret: vi.fn(),
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

describe('writeAntigravityCredentialStoreToken', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.deleteCredential.mockReset();
    mocks.setSecret.mockReset();
    mocks.spawnSync.mockReset();
    mocks.withTarget.mockReset();
    mocks.withTarget.mockReturnValue({
      deleteCredential: mocks.deleteCredential,
      setSecret: mocks.setSecret,
    });
    setPlatform('win32');
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it('updates the native keyring entry without deleting the existing credential first', async () => {
    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/cloud-account/persistence/antigravityCredentialStore');

    writeAntigravityCredentialStoreToken({
      access_token: 'access-new',
      refresh_token: 'refresh-new',
      expiry_timestamp: 1_800_000_000,
    });

    expect(mocks.deleteCredential).not.toHaveBeenCalled();
    expect(mocks.setSecret).toHaveBeenCalledTimes(1);
  });

  it('does not delete the previous credential when the replacement write fails', async () => {
    mocks.setSecret.mockImplementation(() => {
      throw new Error('keyring write failed');
    });
    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/cloud-account/persistence/antigravityCredentialStore');

    expect(() =>
      writeAntigravityCredentialStoreToken({
        access_token: 'access-new',
        refresh_token: 'refresh-new',
        expiry_timestamp: 1_800_000_000,
      }),
    ).toThrow('keyring write failed');

    expect(mocks.deleteCredential).not.toHaveBeenCalled();
  });
});
