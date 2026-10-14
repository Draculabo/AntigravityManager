import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setSecret: vi.fn(),
  writeWindowsCredential: vi.fn(),
  deleteCredential: vi.fn(),
  withTarget: vi.fn(),
  writeMacOSCredentialStore: vi.fn(),
}));
vi.mock('@/modules/antigravity-runtime/credentials/windowsCredentialStore', () => ({
  writeWindowsCredential: mocks.writeWindowsCredential,
}));
vi.mock('@/modules/antigravity-runtime/credentials/macosCredentialStore', () => ({
  writeMacOSCredentialStore: mocks.writeMacOSCredentialStore,
  readMacOSCredentialStore: vi.fn(),
}));
vi.mock('@napi-rs/keyring', () => ({ Entry: { withTarget: mocks.withTarget } }));

const originalPlatform = process.platform;
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
}
describe('writeAntigravityCredentialStoreToken', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    mocks.writeWindowsCredential.mockResolvedValue(undefined);
    mocks.withTarget.mockReturnValue({
      setSecret: mocks.setSecret,
      deleteCredential: mocks.deleteCredential,
    });
  });
  afterEach(() => setPlatform(originalPlatform));

  const token = {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expiry_timestamp: 1_900_000_000,
  };
  it('delegates macOS token installation without changing the token', async () => {
    setPlatform('darwin');
    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/antigravity-runtime/credentials/antigravityCredentialStore');
    await writeAntigravityCredentialStoreToken(token);
    expect(mocks.writeMacOSCredentialStore).toHaveBeenCalledExactlyOnceWith(token);
    expect(mocks.writeWindowsCredential).not.toHaveBeenCalled();
  });
  it('updates Windows credentials without constructing a destructive native Entry', async () => {
    setPlatform('win32');
    const { writeAntigravityCredentialStoreToken } =
      await import('@/modules/antigravity-runtime/credentials/antigravityCredentialStore');
    await writeAntigravityCredentialStoreToken(token);
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
    await expect(writeAntigravityCredentialStoreToken(token)).rejects.toThrow(
      'native keyring update failed',
    );
    expect(mocks.writeWindowsCredential).toHaveBeenCalledTimes(1);
    expect(mocks.withTarget).not.toHaveBeenCalled();
    expect(mocks.deleteCredential).not.toHaveBeenCalled();
  });
});
