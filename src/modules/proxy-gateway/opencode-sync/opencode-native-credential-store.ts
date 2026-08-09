import { Entry } from '@napi-rs/keyring';
import type { OpenCodeCredentialStore } from './opencode-credential.service';

const OPEN_CODE_KEYRING_TARGET = 'antigravity-manager:opencode';
const OPEN_CODE_KEYRING_SERVICE = 'Antigravity Manager';
const OPEN_CODE_KEYRING_ACCOUNT = 'opencode-proxy-key';

export class OpenCodeNativeCredentialStore implements OpenCodeCredentialStore {
  private cachedEntry: Entry | null = null;

  /**
   * Opened on first use, not in a field initializer.
   *
   * `opencode-credentials.ts` constructs this store at module scope and
   * `proxy.guard.ts` imports it, so a field initializer reached the OS keyring
   * during import: every test that pulled in the guard opened a credential
   * store before its first line ran, and failed wherever no keyring is
   * available.
   */
  private get entry(): Entry {
    if (!this.cachedEntry) {
      this.cachedEntry = Entry.withTarget(
        OPEN_CODE_KEYRING_TARGET,
        OPEN_CODE_KEYRING_SERVICE,
        OPEN_CODE_KEYRING_ACCOUNT,
      );
    }

    return this.cachedEntry;
  }

  read(): string | null {
    return this.entry.getPassword();
  }

  write(value: string): void {
    this.entry.setPassword(value);
  }

  delete(): void {
    try {
      this.entry.deleteCredential();
    } catch {
      // Revoking a key that does not exist is idempotent.
    }
  }
}
