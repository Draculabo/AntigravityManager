import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
  setSecret: vi.fn(),
  writeWindowsCredential: vi.fn(),
  deleteCredential: vi.fn(),
  withTarget: vi.fn(),
  writeAgyCliToken: vi.fn(),
  writeGoogleOAuthCredentials: vi.fn(),
}));
vi.mock('@/modules/antigravity-runtime/credentials/windowsCredentialStore', () => ({
  writeWindowsCredential: mocks.writeWindowsCredential,
}));
vi.mock('@napi-rs/keyring', () => ({
  Entry: {
    withTarget: mocks.withTarget,
  },
}));

// The real writer targets the Antigravity CLI session file under the user's
// home, so leaving it unmocked would sign the live CLI out mid-test-run.
vi.mock('@/modules/antigravity-runtime/credentials/agyCliTokenStore', () => ({
  writeAgyCliToken: mocks.writeAgyCliToken,
}));
vi.mock('@/modules/antigravity-runtime/credentials/googleOAuthCredentialStore', () => ({
  writeGoogleOAuthCredentials: mocks.writeGoogleOAuthCredentials,
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    default: {
      ...actual,
      execFileSync: mocks.execFileSync,
      spawnSync: mocks.spawnSync,
    },
    execFileSync: mocks.execFileSync,
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
    mocks.execFileSync.mockReset();
    mocks.spawnSync.mockReset();
    // Default: the keychain item does not exist yet, so writes take the create path.
    mocks.spawnSync.mockReturnValue({ status: 1 });
    mocks.setSecret.mockReset();
    mocks.writeWindowsCredential.mockReset();
    mocks.writeWindowsCredential.mockResolvedValue(undefined);
    mocks.deleteCredential.mockReset();
    mocks.withTarget.mockReset();
    mocks.writeAgyCliToken.mockReset();
    mocks.writeGoogleOAuthCredentials.mockReset();
    mocks.withTarget.mockReturnValue({
      setSecret: mocks.setSecret,
      deleteCredential: mocks.deleteCredential,
    });
    setPlatform('darwin');
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it.each([0, 1])(
    'confirms both macOS password prompts when the existence probe exits %i',
    async (status) => {
      mocks.spawnSync.mockReturnValue({ status });
      mocks.execFileSync.mockImplementation((_file, _args, options: { input: string }) => {
        const [password, confirmation] = options.input.split('\n');
        if (!password || password !== confirmation) {
          throw new Error("passwords don't match");
        }
        expect(options.input).toBe(`${password}\n${password}\n`);
        return Buffer.alloc(0);
      });
      const { writeAntigravityCredentialStoreToken } =
        await import('@/modules/antigravity-runtime/credentials/antigravityCredentialStore');
      await writeAntigravityCredentialStoreToken({
        access_token: 'access-fixture',
        refresh_token: 'refresh-fixture',
        expiry_timestamp: 1_900_000_000,
      });
      expect(mocks.writeAgyCliToken).toHaveBeenCalledTimes(1);
    },
  );

  it('sets the ACL with -A when first creating the macOS keychain item, without exposing the credential in process arguments', async () => {
    mocks.spawnSync.mockReturnValue({ status: 1 }); // item does not exist yet
    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/antigravity-runtime/credentials/antigravityCredentialStore');
    await writeAntigravityCredentialStoreToken({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expiry_timestamp: 1_900_000_000,
    });

    expect(mocks.execFileSync).toHaveBeenCalledTimes(1);
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'security',
      ['add-generic-password', '-s', 'gemini', '-a', 'antigravity', '-A', '-U', '-w'],
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
    expect(mocks.writeGoogleOAuthCredentials).not.toHaveBeenCalled();
  });

  it('updates an existing macOS keychain item without -A so it does not reprompt for ACL changes', async () => {
    mocks.spawnSync.mockReturnValue({ status: 0 }); // item already exists
    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/antigravity-runtime/credentials/antigravityCredentialStore');
    await writeAntigravityCredentialStoreToken({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expiry_timestamp: 1_900_000_000,
    });

    // Existence is probed with a non-prompting attribute read.
    expect(mocks.spawnSync).toHaveBeenCalledWith(
      'security',
      ['find-generic-password', '-s', 'gemini', '-a', 'antigravity'],
      expect.objectContaining({ stdio: 'ignore' }),
    );
    expect(mocks.execFileSync).toHaveBeenCalledTimes(1);
    const args = mocks.execFileSync.mock.calls[0][1] as string[];
    expect(args).toEqual(['add-generic-password', '-s', 'gemini', '-a', 'antigravity', '-U', '-w']);
    expect(args).not.toContain('-A');
  });

  it('syncs generic Google OAuth files only when the caller marks an explicit Agy switch', async () => {
    setPlatform('win32');
    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/antigravity-runtime/credentials/antigravityCredentialStore');
    const token = {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expiry_timestamp: 1_900_000_000,
      id_token: 'id-token',
    };
    await writeAntigravityCredentialStoreToken(token, {
      email: 'active@example.com',
      syncGoogleOAuthFiles: true,
    });

    expect(mocks.writeGoogleOAuthCredentials).toHaveBeenCalledWith({
      ...token,
      email: 'active@example.com',
    });
  });
  it('reports an explicit CLI switch failure when its required OAuth file sync fails', async () => {
    setPlatform('win32');
    mocks.writeGoogleOAuthCredentials.mockImplementationOnce(() => {
      throw new Error('file sync failed');
    });
    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/antigravity-runtime/credentials/antigravityCredentialStore');
    await expect(
      writeAntigravityCredentialStoreToken(
        {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expiry_timestamp: 1_900_000_000,
        },
        {
          email: 'active@example.com',
          syncGoogleOAuthFiles: true,
        },
      ),
    ).rejects.toThrow('file sync failed');
    expect(mocks.writeWindowsCredential).toHaveBeenCalledTimes(1);
  });

  it('propagates update failures without issuing a destructive delete command', async () => {
    mocks.execFileSync.mockImplementation(() => {
      throw new Error('keychain update failed');
    });
    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/antigravity-runtime/credentials/antigravityCredentialStore');
    await expect(
      writeAntigravityCredentialStoreToken({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expiry_timestamp: 1_900_000_000,
      }),
    ).rejects.toThrow('keychain update failed');
    expect(mocks.execFileSync).toHaveBeenCalledTimes(1);
    expect(mocks.execFileSync.mock.calls[0][1]).not.toContain('delete-generic-password');
  });
  it('updates Windows credentials without constructing a destructive native Entry', async () => {
    setPlatform('win32');
    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/antigravity-runtime/credentials/antigravityCredentialStore');
    await writeAntigravityCredentialStoreToken({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expiry_timestamp: 1_900_000_000,
    });
    expect(mocks.withTarget).not.toHaveBeenCalled();
    expect(mocks.writeWindowsCredential).toHaveBeenCalledWith(
      'gemini:antigravity',
      'antigravity',
      expect.stringContaining('"access_token":"access-token"'),
    );
    expect(mocks.setSecret).not.toHaveBeenCalled();
    expect(mocks.deleteCredential).not.toHaveBeenCalled();
  });

  it('preserves the existing native keyring entry when an update fails', async () => {
    setPlatform('win32');
    mocks.writeWindowsCredential.mockRejectedValue(new Error('native keyring update failed'));
    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/antigravity-runtime/credentials/antigravityCredentialStore');
    await expect(
      writeAntigravityCredentialStoreToken({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expiry_timestamp: 1_900_000_000,
      }),
    ).rejects.toThrow('native keyring update failed');
    expect(mocks.writeWindowsCredential).toHaveBeenCalledTimes(1);
    expect(mocks.withTarget).not.toHaveBeenCalled();
    expect(mocks.deleteCredential).not.toHaveBeenCalled();
  });
});
