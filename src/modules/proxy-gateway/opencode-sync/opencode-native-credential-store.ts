import { Entry } from '@napi-rs/keyring';
import type { OpenCodeCredentialStore } from './opencode-credential.service';

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
   *
   * Use the default credential builder (`new Entry(service, account)`).
   * `Entry.withTarget` on macOS expects a keychain kind (`User` / `System` /
   * `Common` / `Dynamic`), not an app-specific namespace string.
   */
  private get entry(): Entry {
    if (!this.cachedEntry) {
      this.cachedEntry = new Entry(OPEN_CODE_KEYRING_SERVICE, OPEN_CODE_KEYRING_ACCOUNT);
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
    // Resolved before the try: opening the keyring used to fail loudly in the
    // constructor, and a failure to open it is not the same thing as a
    // credential that was already gone.
    const entry = this.entry;

    try {
      entry.deleteCredential();
    } catch {
      // Revoking a key that does not exist is idempotent.
    }
  }
}
