import { beforeEach, describe, expect, it, vi } from 'vitest';

const keyringMocks = vi.hoisted(() => ({
  withTarget: vi.fn(),
  getPassword: vi.fn(() => 'stored-key'),
  setPassword: vi.fn(),
  deleteCredential: vi.fn(),
}));

vi.mock('@napi-rs/keyring', () => ({
  Entry: {
    withTarget: keyringMocks.withTarget,
  },
}));

import { OpenCodeNativeCredentialStore } from '@/modules/proxy-gateway/opencode-sync/opencode-native-credential-store';

describe('OpenCodeNativeCredentialStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    keyringMocks.withTarget.mockReturnValue({
      getPassword: keyringMocks.getPassword,
      setPassword: keyringMocks.setPassword,
      deleteCredential: keyringMocks.deleteCredential,
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

    expect(keyringMocks.withTarget).not.toHaveBeenCalled();
  });

  it('opens the keyring on first use and reuses it afterwards', () => {
    const store = new OpenCodeNativeCredentialStore();

    expect(store.read()).toBe('stored-key');
    store.write('next-key');

    expect(keyringMocks.withTarget).toHaveBeenCalledOnce();
    expect(keyringMocks.withTarget).toHaveBeenCalledWith(
      'antigravity-manager:opencode',
      'Antigravity Manager',
      'opencode-proxy-key',
    );
    expect(keyringMocks.setPassword).toHaveBeenCalledWith('next-key');
  });

  it('treats deleting an absent credential as done', () => {
    keyringMocks.deleteCredential.mockImplementationOnce(() => {
      throw new Error('No matching entry found in secure storage');
    });
    const store = new OpenCodeNativeCredentialStore();

    expect(() => store.delete()).not.toThrow();
  });
});
