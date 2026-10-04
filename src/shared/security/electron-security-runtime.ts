import path from 'node:path';
import { app, safeStorage } from 'electron';
import { configureSecurityRuntime, createKeytarProviders } from '@/shared/security/security';
import {
  FileMasterKeyProvider,
  LegacyFileMasterKeyProvider,
} from '@/shared/security/key-providers/file-provider';
import {
  LegacySafeStorageProvider,
  SafeStorageMasterKeyProvider,
} from '@/shared/security/key-providers/safe-storage-provider';
import type { SecurityStatus } from '@/shared/security/master-key-manager';

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

export function configureElectronSecurityRuntime(): void {
  const userDataPath = app.getPath('userData');
  const legacyKeyPath = path.join(userDataPath, '.mk');
  const { current, legacy } = createKeytarProviders();

  configureSecurityRuntime({
    recoveryHint: getRecoveryHint(),
    providers: [
      new SafeStorageMasterKeyProvider(path.join(userDataPath, 'master-key.v2.safe'), safeStorage),
      current,
      new FileMasterKeyProvider(path.join(userDataPath, 'master-key.v2.file')),
      new LegacySafeStorageProvider(legacyKeyPath, safeStorage),
      legacy,
      new LegacyFileMasterKeyProvider(legacyKeyPath),
    ],
  });
}
