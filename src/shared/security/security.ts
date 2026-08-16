import path from 'node:path';
import { app, safeStorage } from 'electron';
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
  type SecurityStatus,
} from '@/shared/security/master-key-manager';
import {
  FileMasterKeyProvider,
  LegacyFileMasterKeyProvider,
} from '@/shared/security/key-providers/file-provider';
import {
  KeytarMasterKeyProvider,
  LegacyKeytarMasterKeyProvider,
  type KeytarAdapter,
} from '@/shared/security/key-providers/keytar-provider';
import {
  LegacySafeStorageProvider,
  SafeStorageMasterKeyProvider,
} from '@/shared/security/key-providers/safe-storage-provider';
import { normalizeSecurityStatus } from '@/shared/security/security-status';

const SERVICE_NAME = 'AntigravityManager';
const V2_KEYTAR_ACCOUNT_NAME = 'MasterKeyV2';
const LEGACY_KEYTAR_ACCOUNT_NAME = 'MasterKey';

export type { KeySource, SecurityStatus };

let masterKeyManager: MasterKeyManager | null = null;

function createKeytarLoader(): () => Promise<KeytarAdapter> {
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

function getRecoveryHint(): NonNullable<SecurityStatus['recoveryHint']> {
  if (process.platform !== 'darwin') {
    return 'HINT_RECOVERY';
  }

  try {
    if (app.getAppPath().includes('/AppTranslocation/')) {
      return 'HINT_APP_TRANSLOCATION';
    }
  } catch {
    return 'HINT_MANUAL_SIGN';
  }

  return 'HINT_MANUAL_SIGN';
}

function getRuntimeSecurityStatus(manager: MasterKeyManager): SecurityStatus {
  let safeStorageBackend: string | undefined;
  if (process.platform === 'linux') {
    try {
      safeStorageBackend = safeStorage.getSelectedStorageBackend();
    } catch {
      safeStorageBackend = undefined;
    }
  }

  return normalizeSecurityStatus(manager.getSecurityStatus(), {
    platform: process.platform,
    safeStorageBackend,
  });
}

function createMasterKeyManager(): MasterKeyManager {
  const userDataPath = app.getPath('userData');
  const legacyKeyPath = path.join(userDataPath, '.mk');
  const safeKeyPath = path.join(userDataPath, 'master-key.v2.safe');
  const fileKeyPath = path.join(userDataPath, 'master-key.v2.file');
  const loadKeytar = createKeytarLoader();

  return new MasterKeyManager({
    recoveryHint: getRecoveryHint(),
    providers: [
      new SafeStorageMasterKeyProvider(safeKeyPath, safeStorage),
      new KeytarMasterKeyProvider(SERVICE_NAME, V2_KEYTAR_ACCOUNT_NAME, loadKeytar),
      new FileMasterKeyProvider(fileKeyPath),
      new LegacySafeStorageProvider(legacyKeyPath, safeStorage),
      new LegacyKeytarMasterKeyProvider(SERVICE_NAME, LEGACY_KEYTAR_ACCOUNT_NAME, loadKeytar),
      new LegacyFileMasterKeyProvider(legacyKeyPath),
    ],
  });
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
  return getRuntimeSecurityStatus(manager);
}

export function getSecurityStatus(): SecurityStatus {
  return getRuntimeSecurityStatus(getMasterKeyManager());
}

export async function encrypt(text: string): Promise<string> {
  const { key } = getMasterKeyManager().getPrimaryKey();
  return encryptWithKey(key, text);
}

export async function decryptWithMigration(
  text: string,
): Promise<{ value: string; reencrypted?: string; usedFallback?: KeySource }> {
  if (text.startsWith('{') || text.startsWith('[')) {
    return { value: text };
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

      return {
        value,
        reencrypted: payload.isVersioned ? undefined : `${ENCRYPTED_PAYLOAD_VERSION_PREFIX}${text}`,
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
