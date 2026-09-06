import { randomBytes, timingSafeEqual } from 'node:crypto';

export interface OpenCodeCredentialStore {
  read(): string | null;
  write(value: string): void;
  delete(): void;
}

type RandomBytesFactory = () => Buffer;

export class OpenCodeCredentialService {
  constructor(
    private readonly store: OpenCodeCredentialStore,
    private readonly createRandomBytes: RandomBytesFactory = () => randomBytes(32),
  ) {}

  getOrCreate(): string {
    const current = this.store.read();
    if (current) {
      return current;
    }

    return this.rotate();
  }

  rotate(): string {
    const nextKey = `agm_oc_${this.createRandomBytes().toString('base64url')}`;
    this.store.write(nextKey);
    return nextKey;
  }

  revoke(): void {
    this.store.delete();
  }

  hasKey(): boolean {
    return Boolean(this.readCurrentKey());
  }

  matches(candidate: string | null | undefined): boolean {
    if (!candidate) {
      return false;
    }

    const current = this.readCurrentKey();
    if (!current) {
      return false;
    }

    const currentBytes = Buffer.from(current);
    const candidateBytes = Buffer.from(candidate);
    if (currentBytes.length !== candidateBytes.length) {
      return false;
    }

    return timingSafeEqual(currentBytes, candidateBytes);
  }

  /**
   * Optional OpenCode auth must never take down the model proxy. A missing or
   * unusable keyring is treated as "no dedicated OpenCode key".
   */
  private readCurrentKey(): string | null {
    try {
      return this.store.read();
    } catch {
      return null;
    }
  }
}
