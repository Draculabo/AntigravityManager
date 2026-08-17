import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  setSecret: vi.fn(),
  deleteCredential: vi.fn(),
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
      execFileSync: mocks.execFileSync,
    },
    execFileSync: mocks.execFileSync,
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
    mocks.execFileSync.mockReset();
    mocks.setSecret.mockReset();
    mocks.deleteCredential.mockReset();
    mocks.withTarget.mockReset();
    mocks.withTarget.mockReturnValue({
      setSecret: mocks.setSecret,
      deleteCredential: mocks.deleteCredential,
    });
    setPlatform('darwin');
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it('updates the macOS keychain item without exposing the credential in process arguments', async () => {
    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/cloud-account/persistence/antigravityCredentialStore');

    writeAntigravityCredentialStoreToken({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expiry_timestamp: 1_900_000_000,
    });

    expect(mocks.execFileSync).toHaveBeenCalledTimes(1);
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'security',
      [
        'add-generic-password',
        '-s',
        'gemini',
        '-a',
        'antigravity',
        '-A',
        '-U',
        '-w',
      ],
      expect.objectContaining({
        input: expect.stringContaining('go-keyring-base64:'),
        encoding: 'utf-8',
        stdio: ['pipe', 'ignore', 'ignore'],
      }),
    );

    const args = mocks.execFileSync.mock.calls[0][1] as string[];
    expect(args.join(' ')).not.toContain('access-token');
    expect(args.join(' ')).not.toContain('refresh-token');
    expect(args).not.toContain('delete-generic-password');
  });

  it('propagates update failures without issuing a destructive delete command', async () => {
    mocks.execFileSync.mockImplementation(() => {
      throw new Error('keychain update failed');
    });
    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/cloud-account/persistence/antigravityCredentialStore');

    expect(() =>
      writeAntigravityCredentialStoreToken({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expiry_timestamp: 1_900_000_000,
      }),
    ).toThrow('keychain update failed');

    expect(mocks.execFileSync).toHaveBeenCalledTimes(1);
    expect(mocks.execFileSync.mock.calls[0][1]).not.toContain('delete-generic-password');
  });
});