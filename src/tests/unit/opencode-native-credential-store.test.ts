import { beforeEach, describe, expect, it, vi } from 'vitest';

const keyringMocks = vi.hoisted(() => ({
  Entry: vi.fn(),
  getPassword: vi.fn(() => 'stored-key'),
  setPassword: vi.fn(),
  deleteCredential: vi.fn(),
}));

vi.mock('@napi-rs/keyring', () => ({
  Entry: keyringMocks.Entry,
}));

import { OpenCodeNativeCredentialStore } from '@/modules/proxy-gateway/opencode-sync/opencode-native-credential-store';

describe('OpenCodeNativeCredentialStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    keyringMocks.Entry.mockImplementation(function MockEntry(this: {
      getPassword: typeof keyringMocks.getPassword;
      setPassword: typeof keyringMocks.setPassword;
      deleteCredential: typeof keyringMocks.deleteCredential;
    }) {
      this.getPassword = keyringMocks.getPassword;
      this.setPassword = keyringMocks.setPassword;
      this.deleteCredential = keyringMocks.deleteCredential;
    });
  });

  /**
   * `opencode-credentials.ts` constructs the store at module scope and
   * `proxy.guard.ts` imports it, so opening the keyring in a field initializer
   * reaches the OS credential store during import. Anywhere without a keyring,
   * that fails every test that pulls in the guard.
   */
  it('does not open the keyring while being constructed', () => {
    new OpenCodeNativeCredentialStore();

    expect(keyringMocks.Entry).not.toHaveBeenCalled();
  });

  it('opens the default keyring entry on first use and reuses it afterwards', () => {
    const store = new OpenCodeNativeCredentialStore();

    expect(store.read()).toBe('stored-key');
    store.write('next-key');

    expect(keyringMocks.Entry).toHaveBeenCalledOnce();
    expect(keyringMocks.Entry).toHaveBeenCalledWith('Antigravity Manager', 'opencode-proxy-key');
    expect(keyringMocks.setPassword).toHaveBeenCalledWith('next-key');
  });

  it('treats deleting an absent credential as done', () => {
    keyringMocks.deleteCredential.mockImplementationOnce(() => {
      throw new Error('No matching entry found in secure storage');
    });
    const store = new OpenCodeNativeCredentialStore();

    expect(() => store.delete()).not.toThrow();
  });

  /**
   * Opening the keyring used to fail in the constructor, where nothing hid it.
   * Now that it happens on first use, `delete()` must not fold that failure
   * into the idempotent "already gone" case.
   */
  it('still reports a keyring that cannot be opened at all', () => {
    keyringMocks.Entry.mockImplementation(() => {
      throw new Error("Value of 'keychain' is invalid: unknown key");
    });
    const store = new OpenCodeNativeCredentialStore();

    expect(() => store.delete()).toThrow("Value of 'keychain' is invalid: unknown key");
  });
});
