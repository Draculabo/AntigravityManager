import { Entry } from '@napi-rs/keyring';
import type { OpenCodeCredentialStore } from './opencode-credential.service';

const OPEN_CODE_KEYRING_TARGET = 'antigravity-manager:opencode';
const OPEN_CODE_KEYRING_SERVICE = 'Antigravity Manager';
const OPEN_CODE_KEYRING_ACCOUNT = 'opencode-proxy-key';

export class OpenCodeNativeCredentialStore implements OpenCodeCredentialStore {
  private readonly entry = Entry.withTarget(
    OPEN_CODE_KEYRING_TARGET,
    OPEN_CODE_KEYRING_SERVICE,
    OPEN_CODE_KEYRING_ACCOUNT,
  );

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
