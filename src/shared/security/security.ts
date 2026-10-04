import { logger } from '@/shared/logging/logger';
import { AppError } from '@/shared/errors/appError';
import {
  decryptParsedPayloadWithKey,
  encryptWithKey,
  ENCRYPTED_PAYLOAD_VERSION_PREFIX,
  isEncryptedPayloadCandidate,
  parseEncryptedPayload,
} from '@/shared/security/crypto';
import {
  MasterKeyManager,
  type InitializeMasterKeyOptions,
  type KeySource,
  type MasterKeyProvider,
  type SecurityStatus,
} from '@/shared/security/master-key-manager';
import {
  KeytarMasterKeyProvider,
  LegacyKeytarMasterKeyProvider,
  type KeytarAdapter,
} from '@/shared/security/key-providers/keytar-provider';

const SERVICE_NAME = 'AntigravityManager';
const V2_KEYTAR_ACCOUNT_NAME = 'MasterKeyV2';
const LEGACY_KEYTAR_ACCOUNT_NAME = 'MasterKey';

export type { KeySource, SecurityStatus };

let masterKeyManager: MasterKeyManager | null = null;
let runtimeConfiguration: {
  providers: MasterKeyProvider[];
  recoveryHint: NonNullable<SecurityStatus['recoveryHint']>;
} | null = null;

export function createKeytarLoader(): () => Promise<KeytarAdapter> {
  let loadedKeytar: Promise<KeytarAdapter> | null = null;

  return async () => {
    loadedKeytar ??= import('keytar').then(async ({ default: keytar }) => {
      await keytar.findCredentials(SERVICE_NAME);
      return keytar;
    });

    try {
      return await loadedKeytar;
    } catch (error) {
      // Native keyring loading can fail temporarily. A retry must perform a fresh load.
      loadedKeytar = null;
      throw error;
    }
  };
}

function createMasterKeyManager(): MasterKeyManager {
  if (runtimeConfiguration) {
    return new MasterKeyManager(runtimeConfiguration);
  }

  // The standalone Node runtime writes only to the OS credential store.
  return new MasterKeyManager({
    providers: [
      new KeytarMasterKeyProvider(SERVICE_NAME, V2_KEYTAR_ACCOUNT_NAME, createKeytarLoader()),
    ],
  });
}

/** Configure the desktop's legacy providers before any account data is opened. */
export function configureSecurityRuntime(configuration: {
  providers: MasterKeyProvider[];
  recoveryHint: NonNullable<SecurityStatus['recoveryHint']>;
}): void {
  if (masterKeyManager) {
    throw new Error('Security runtime has already been initialized');
  }

  runtimeConfiguration = {
    providers: [...configuration.providers],
    recoveryHint: configuration.recoveryHint,
  };
}

export function createKeytarProviders(loadKeytar = createKeytarLoader()): {
  current: KeytarMasterKeyProvider;
  legacy: LegacyKeytarMasterKeyProvider;
} {
  return {
    current: new KeytarMasterKeyProvider(SERVICE_NAME, V2_KEYTAR_ACCOUNT_NAME, loadKeytar),
    legacy: new LegacyKeytarMasterKeyProvider(SERVICE_NAME, LEGACY_KEYTAR_ACCOUNT_NAME, loadKeytar),
  };
}

/** Copy the resolved desktop key to the OS keyring for standalone Node use. */
export async function ensureHeadlessMasterKeyAvailable(): Promise<void> {
  const { key } = getMasterKeyManager().getPrimaryKey();
  const provider = createKeytarProviders().current;
  const existing = await provider.read();

  if (existing.status === 'available' && existing.key.equals(key)) {
    return;
  }

  if (existing.status !== 'missing') {
    throw new AppError(
      'MASTER_KEY_UNAVAILABLE',
      'OS keyring master key is unavailable or differs',
      {
        messageKey: 'error.masterKeyUnavailable',
        metadata: { hint: 'HINT_RECOVERY', reason: 'PROVIDER_UNAVAILABLE', storedAccountCount: 0 },
      },
    );
  }

  try {
    await provider.write(key);
  } catch (cause) {
    throw new AppError('MASTER_KEY_UNAVAILABLE', 'Cannot migrate master key to OS keyring', {
      messageKey: 'error.masterKeyUnavailable',
      metadata: { hint: 'HINT_RECOVERY', reason: 'PROVIDER_UNAVAILABLE', storedAccountCount: 0 },
      cause,
    });
  }

  const verified = await provider.read();
  if (verified.status !== 'available' || !verified.key.equals(key)) {
    throw new AppError('MASTER_KEY_UNAVAILABLE', 'OS keyring master key verification failed', {
      messageKey: 'error.masterKeyUnavailable',
      metadata: { hint: 'HINT_RECOVERY', reason: 'PROVIDER_UNAVAILABLE', storedAccountCount: 0 },
    });
  }
}

function getMasterKeyManager(): MasterKeyManager {
  masterKeyManager ??= createMasterKeyManager();
  return masterKeyManager;
}

export async function initializeMasterKey(
  options: InitializeMasterKeyOptions,
): Promise<SecurityStatus> {
  const manager = getMasterKeyManager();
  await manager.initialize(options);
  return manager.getSecurityStatus();
}

export function getSecurityStatus(): SecurityStatus {
  return getMasterKeyManager().getSecurityStatus();
}

export async function encrypt(text: string): Promise<string> {
  const { key } = getMasterKeyManager().getPrimaryKey();
  return encryptWithKey(key, text);
}

export async function decryptWithMigration(
  text: string,
): Promise<{ value: string; reencrypted?: string; usedFallback?: KeySource }> {
  const trimmedText = text.trimStart();
  if (trimmedText.startsWith('{') || trimmedText.startsWith('[')) {
    if (trimmedText === text) {
      return { value: text };
    }

    const { key } = getMasterKeyManager().getPrimaryKey();
    return {
      value: text,
      reencrypted: encryptWithKey(key, text),
    };
  }

  const payload = parseEncryptedPayload(text);
  if (!payload) {
    if (isEncryptedPayloadCandidate(text)) {
      logger.warn('Security: Invalid encrypted data format');
      throw new Error('Invalid encrypted data format');
    }

    return { value: text };
  }

  const manager = getMasterKeyManager();
  const primary = manager.getPrimaryKey();
  const candidates = manager.getDecryptionKeys();
  let firstError: unknown;

  for (const candidate of candidates) {
    try {
      const value = decryptParsedPayloadWithKey(candidate.key, payload);
      const usedFallback = candidate.key.equals(primary.key) ? undefined : candidate.source;
      const reencrypted = usedFallback
        ? encryptWithKey(primary.key, value)
        : payload.isVersioned
          ? undefined
          : `${ENCRYPTED_PAYLOAD_VERSION_PREFIX}${text}`;

      return {
        value,
        reencrypted,
        usedFallback,
      };
    } catch (error) {
      firstError ??= error;
    }
  }

  logger.error(
    'Security: Decryption failed - authentication tag mismatch (wrong key or corrupted data)',
  );
  throw new AppError('DATA_MIGRATION_FAILED', 'Data migration failed', {
    messageKey: 'error.dataMigrationFailed',
    detailMessageKey: 'error.dataMigrationHint.relogin',
    metadata: { hint: 'HINT_RELOGIN' },
    cause: firstError,
  });
}

export async function decrypt(text: string): Promise<string> {
  const result = await decryptWithMigration(text);
  return result.value;
}

export { ENCRYPTED_PAYLOAD_VERSION_PREFIX };
