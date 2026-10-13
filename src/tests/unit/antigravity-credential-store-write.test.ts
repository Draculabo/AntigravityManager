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
    'round-trips a long macOS credential when the existence probe exits %i',
    async (status) => {
      const accessToken = `access-fixture-${'a'.repeat(6000)}`;
      let stored = '';
      mocks.spawnSync.mockImplementation((_file: string, args: string[]) =>
        args.includes('-w') ? { status: 0, stdout: Buffer.from(`${stored}\n`) } : { status },
      );
      mocks.execFileSync.mockImplementation(
        (_file: string, args: string[], options: { input?: string }) => {
          // security treats a -w argument as the complete password; its prompt
          // instead discards ASCII bytes beyond 128 (Apple Libc getpass).
          const value = args[args.indexOf('-w') + 1];
          stored = value ?? (options.input ?? '').split('\n')[0].slice(0, 128);
          return Buffer.alloc(0);
        },
      );
      const { writeAntigravityCredentialStoreToken, readAntigravityCredentialStoreToken } =
        await import('@/modules/antigravity-runtime/credentials/antigravityCredentialStore');
      await writeAntigravityCredentialStoreToken({
        access_token: accessToken,
        refresh_token: 'refresh-fixture',
        expiry_timestamp: 1_900_000_000,
        id_token: 'id-fixture',
        project_id: 'project-fixture',
      });
      expect(Buffer.byteLength(stored)).toBeGreaterThan(6000);
      expect(await readAntigravityCredentialStoreToken()).toEqual({
        accessToken,
        refreshToken: 'refresh-fixture',
        expiryTimestamp: 1_900_000_000,
        idToken: 'id-fixture',
        projectId: 'project-fixture',
      });
      expect(mocks.writeAgyCliToken).not.toHaveBeenCalled();
    },
  );

  it('sets the ACL with -A only when creating the macOS keychain item', async () => {
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
      '/usr/bin/security',
      [
        'add-generic-password',
        '-s',
        'gemini',
        '-a',
        'antigravity',
        '-A',
        '-U',
        '-w',
        expect.stringContaining('go-keyring-base64:'),
      ],
      expect.objectContaining({
        encoding: 'utf-8',
        stdio: 'ignore',
        timeout: 10_000,
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
      '/usr/bin/security',
      ['find-generic-password', '-s', 'gemini', '-a', 'antigravity'],
      expect.objectContaining({ stdio: 'ignore' }),
    );
    expect(mocks.execFileSync).toHaveBeenCalledTimes(1);
    const args = mocks.execFileSync.mock.calls[0][1] as string[];
    expect(args).toEqual([
      'add-generic-password',
      '-s',
      'gemini',
      '-a',
      'antigravity',
      '-U',
      '-w',
      expect.stringContaining('go-keyring-base64:'),
    ]);
    expect(args).not.toContain('-A');
  });

  it('propagates update failures without issuing a destructive delete command', async () => {
    mocks.execFileSync.mockImplementation(() => {
      throw Object.assign(new Error('Command failed with go-keyring-base64:secret-fixture'), {
        cmd: 'security -w go-keyring-base64:secret-fixture',
        stderr: Buffer.from('refresh-secret-leak'),
      });
    });
    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/antigravity-runtime/credentials/antigravityCredentialStore');
    await expect(
      writeAntigravityCredentialStoreToken({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expiry_timestamp: 1_900_000_000,
      }),
    ).rejects.toThrow('Failed to write the Antigravity macOS credential store.');
    expect(mocks.execFileSync).toHaveBeenCalledTimes(1);
    expect(mocks.execFileSync.mock.calls[0][1]).not.toContain('delete-generic-password');
    try {
      await writeAntigravityCredentialStoreToken({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expiry_timestamp: 1_900_000_000,
      });
      expect.unreachable('Expected the credential write to fail');
    } catch (error) {
      expect(error).not.toHaveProperty('cmd');
      expect(error).not.toHaveProperty('cause');
      expect(error).not.toHaveProperty('stderr');
      expect(String(error)).not.toContain('secret-fixture');
      expect(String(error)).not.toContain('refresh-secret-leak');
    }
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
