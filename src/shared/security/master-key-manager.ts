import crypto from 'node:crypto';
import { AppError } from '@/shared/errors/appError';
import { canDecryptPayloadWithKey } from '@/shared/security/crypto';

export type KeySource =
  | 'safeStorage'
  | 'keytar'
  | 'file'
  | 'legacy-safeStorage'
  | 'legacy-keytar'
  | 'legacy-file';

export type KeyReadResult =
  | { status: 'available'; key: Buffer; source: KeySource }
  | { status: 'missing'; source: KeySource }
  | { status: 'unavailable'; source: KeySource; error: unknown }
  | { status: 'corrupt'; source: KeySource; error: unknown };

export interface MasterKeyProvider {
  source: KeySource;
  read(): Promise<KeyReadResult>;
  write?(key: Buffer): Promise<void>;
}

export interface SecurityStatus {
  state: 'secure' | 'degraded' | 'locked';
  masterKeySource?: KeySource;
  recoveryHint?:
    | 'HINT_APP_TRANSLOCATION'
    | 'HINT_KEYCHAIN_DENIED'
    | 'HINT_MANUAL_SIGN'
    | 'HINT_RECOVERY';
}

type RecoveryHint = NonNullable<SecurityStatus['recoveryHint']>;

interface MasterKeyManagerOptions {
  providers: MasterKeyProvider[];
  generateKey?: () => Buffer;
  recoveryHint?: RecoveryHint;
}

export interface InitializeMasterKeyOptions {
  encryptedSamples: string[];
  storedAccountCount?: number;
}

export interface ResolvedMasterKey {
  key: Buffer;
  source: KeySource;
}

/**
 * MASTER KEY INVARIANTS
 *
 * 1. Existing key material is never overwritten during recovery.
 * 2. A new master key is never generated while encrypted user data exists but cannot be decrypted.
 * 3. Providers store the same master key and never generate independent keys.
 * 4. An unavailable provider is not treated as a missing key.
 * 5. Provider migration never requires re-encrypting account data.
 */
export class MasterKeyManager {
  private readonly providers: MasterKeyProvider[];
  private readonly generateKey: () => Buffer;
  private readonly recoveryHint: RecoveryHint;
  private resolved: ResolvedMasterKey | null = null;
  private decryptionKeys: ResolvedMasterKey[] = [];
  private initializationInProgress: Promise<ResolvedMasterKey> | null = null;
  private status: SecurityStatus = { state: 'locked', recoveryHint: 'HINT_RECOVERY' };

  constructor({
    providers,
    generateKey = () => crypto.randomBytes(32),
    recoveryHint = 'HINT_RECOVERY',
  }: MasterKeyManagerOptions) {
    this.providers = providers;
    this.generateKey = generateKey;
    this.recoveryHint = recoveryHint;
  }

  private async persistResolvedKey(
    key: Buffer,
    results: KeyReadResult[],
  ): Promise<KeySource | undefined> {
    for (const [index, provider] of this.providers.entries()) {
      if (!provider.write) {
        continue;
      }

      const result = results[index];
      if (result.status === 'available') {
        if (result.key.equals(key)) {
          return provider.source;
        }
        continue;
      }
      if (result.status !== 'missing') {
        continue;
      }

      try {
        await provider.write(key);
        return provider.source;
      } catch {
        continue;
      }
    }

    return undefined;
  }

  async initialize(options: InitializeMasterKeyOptions): Promise<ResolvedMasterKey> {
    if (this.resolved) {
      return this.resolved;
    }
    if (this.initializationInProgress) {
      return this.initializationInProgress;
    }

    this.initializationInProgress = this.resolve(options);
    try {
      return await this.initializationInProgress;
    } finally {
      this.initializationInProgress = null;
    }
  }

  private async resolve({
    encryptedSamples,
    storedAccountCount = encryptedSamples.length,
  }: InitializeMasterKeyOptions): Promise<ResolvedMasterKey> {
    const results = await Promise.all(this.providers.map((provider) => provider.read()));
    const availableResults = results.filter(
      (result): result is Extract<KeyReadResult, { status: 'available' }> =>
        result.status === 'available',
    );
    const uniqueCandidates = new Map<string, (typeof availableResults)[number]>();
    for (const candidate of availableResults) {
      const fingerprint = candidate.key.toString('hex');
      if (!uniqueCandidates.has(fingerprint)) {
        uniqueCandidates.set(fingerprint, candidate);
      }
    }
    const candidates = Array.from(uniqueCandidates.values());
    const candidateCoverage = candidates.map((candidate, index) => {
      const coverage = encryptedSamples.filter((sample) => {
        return canDecryptPayloadWithKey(sample, candidate.key);
      }).length;
      return { candidate, coverage, index };
    });
    const matchingCandidates = candidateCoverage
      .filter(({ coverage }) => coverage > 0)
      .sort((left, right) => right.coverage - left.coverage || left.index - right.index);
    const matchingCandidate = matchingCandidates[0]?.candidate;

    if (encryptedSamples.length > 0 && !matchingCandidate) {
      this.status = { state: 'locked', recoveryHint: this.recoveryHint };
      throw new AppError('MASTER_KEY_UNAVAILABLE', 'Unable to resolve stored master key', {
        messageKey: 'error.masterKeyUnavailable',
        metadata: {
          hint: this.recoveryHint,
          reason: 'NO_MATCHING_KEY',
          storedAccountCount,
        },
      });
    }

    const selected = matchingCandidate ?? candidates[0];
    if (selected) {
      const persistedSource = await this.persistResolvedKey(selected.key, results);
      this.resolved = { key: selected.key, source: persistedSource ?? selected.source };
      this.decryptionKeys = [
        this.resolved,
        ...matchingCandidates
          .map(({ candidate }) => ({ key: candidate.key, source: candidate.source }))
          .filter(({ key }) => !key.equals(selected.key)),
      ];
      this.status = {
        state:
          this.decryptionKeys.length === 1 &&
          (this.resolved.source === 'safeStorage' || this.resolved.source === 'keytar')
            ? 'secure'
            : 'degraded',
        masterKeySource: this.resolved.source,
      };
      return this.resolved;
    }

    const hasBlockingExistingMaterial = results.some((result) => {
      if (result.status === 'corrupt') {
        return true;
      }
      if (result.status !== 'unavailable') {
        return false;
      }

      return result.source !== 'keytar' && result.source !== 'legacy-keytar';
    });
    if (hasBlockingExistingMaterial) {
      this.status = { state: 'locked', recoveryHint: this.recoveryHint };
      throw new AppError('MASTER_KEY_UNAVAILABLE', 'Existing master-key material is unavailable', {
        messageKey: 'error.masterKeyUnavailable',
        metadata: {
          hint: this.recoveryHint,
          reason: 'PROVIDER_UNAVAILABLE',
          storedAccountCount,
        },
      });
    }

    const key = this.generateKey();
    for (const provider of this.providers) {
      if (!provider.write) {
        continue;
      }

      try {
        await provider.write(key);
        this.resolved = { key, source: provider.source };
        this.decryptionKeys = [this.resolved];
        this.status = {
          state:
            provider.source === 'safeStorage' || provider.source === 'keytar'
              ? 'secure'
              : 'degraded',
          masterKeySource: provider.source,
        };
        return this.resolved;
      } catch {
        continue;
      }
    }

    this.status = { state: 'locked', recoveryHint: this.recoveryHint };
    throw new AppError('MASTER_KEY_UNAVAILABLE', 'No writable master-key provider', {
      messageKey: 'error.masterKeyUnavailable',
      metadata: {
        hint: this.recoveryHint,
        reason: 'PROVIDER_UNAVAILABLE',
        storedAccountCount,
      },
    });
  }

  getSecurityStatus(): SecurityStatus {
    return this.status;
  }

  getDecryptionKeys(): ResolvedMasterKey[] {
    return this.decryptionKeys.map(({ key, source }) => ({ key, source }));
  }

  getPrimaryKey(): ResolvedMasterKey {
    if (this.resolved) {
      return this.resolved;
    }

    throw new AppError('MASTER_KEY_UNAVAILABLE', 'Master key has not been initialized', {
      messageKey: 'error.masterKeyUnavailable',
      metadata: {
        hint: this.recoveryHint,
        reason: 'NOT_INITIALIZED',
        storedAccountCount: 0,
      },
    });
  }
}
