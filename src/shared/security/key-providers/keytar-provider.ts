import type {
  KeyReadResult,
  KeySource,
  MasterKeyProvider,
} from '@/shared/security/master-key-manager';

const MASTER_KEY_HEX_PATTERN = /^[a-f0-9]{64}$/i;

export interface KeytarAdapter {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
}

type KeytarLoader = () => Promise<KeytarAdapter>;

abstract class BaseKeytarProvider implements MasterKeyProvider {
  abstract readonly source: KeySource;

  constructor(
    private readonly service: string,
    private readonly account: string,
    private readonly loadKeytar: KeytarLoader,
  ) {}

  async read(): Promise<KeyReadResult> {
    try {
      const keytar = await this.loadKeytar();
      const value = await keytar.getPassword(this.service, this.account);
      if (!value) {
        return { status: 'missing', source: this.source };
      }
      if (!MASTER_KEY_HEX_PATTERN.test(value)) {
        return {
          status: 'corrupt',
          source: this.source,
          error: new Error(`${this.source} key has an invalid format`),
        };
      }

      return { status: 'available', source: this.source, key: Buffer.from(value, 'hex') };
    } catch (error) {
      return { status: 'unavailable', source: this.source, error };
    }
  }

  protected async writeNewKey(key: Buffer): Promise<void> {
    const keytar = await this.loadKeytar();
    const existing = await keytar.getPassword(this.service, this.account);
    if (existing) {
      if (MASTER_KEY_HEX_PATTERN.test(existing) && Buffer.from(existing, 'hex').equals(key)) {
        return;
      }

      throw new Error(`${this.source} slot contains a different master key`);
    }

    await keytar.setPassword(this.service, this.account, key.toString('hex'));
  }
}

export class KeytarMasterKeyProvider extends BaseKeytarProvider {
  readonly source = 'keytar' as const;

  write(key: Buffer): Promise<void> {
    return this.writeNewKey(key);
  }
}

export class LegacyKeytarMasterKeyProvider extends BaseKeytarProvider {
  readonly source = 'legacy-keytar' as const;
}
