import fs from 'node:fs';
import { logger } from '@/shared/logging/logger';
import { getAntigravityDbPaths, type PathResolutionOptions } from '@/shared/platform/paths';
import type { AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import type { ClientAccountCredentials } from './clientAccount';
import { CredentialReadbackError } from '@/shared/auth/credentialReadbackError';
import type { ClientAccountStorage, PreparedClientAccountWrite } from './clientAccountWrite';
import {
  readMacOSCredentialStore,
  syncMacOSCredentialFiles,
  writeMacOSCredentialStore,
} from './macosCredentialStore';
import {
  backupMacOSClientDatabase,
  writeMacOSClientDatabase,
  writeMacOSServiceMachineId,
} from './macosClientSqlite';

export function prepareMacOSClientAccountWrite(
  input: ClientAccountCredentials,
  target: AntigravityAppTarget,
  storage: ClientAccountStorage,
  pathOptions?: PathResolutionOptions,
): PreparedClientAccountWrite {
  const credentials = structuredClone(input);
  const paths = getAntigravityDbPaths(target, pathOptions);
  const dbPath = paths.find((file) => fs.existsSync(file)) ?? paths[0];
  const syncMachineId = (file: string) => {
    if (credentials.serviceMachineId !== undefined) {
      try {
        writeMacOSServiceMachineId(file, credentials.serviceMachineId);
      } catch {
        // Machine-ID synchronization does not change the token-write result.
      }
    }
  };
  const writeSystemCredentials = () => {
    writeMacOSCredentialStore(credentials.token);
    try {
      syncMacOSCredentialFiles(credentials);
    } catch {
      logger.warn('File credential sync warning');
    }
  };
  return {
    storage,
    write: async () => {
      if (target === 'agy') {
        writeSystemCredentials();
        const stored = readMacOSCredentialStore(false);
        if (
          !credentials.token.refresh_token ||
          stored.refreshToken !== credentials.token.refresh_token
        ) {
          throw new CredentialReadbackError(
            'Stored agy credentials do not match the selected account; the switch was not confirmed.',
            {
              refreshToken:
                Boolean(credentials.token.refresh_token) &&
                stored.refreshToken === credentials.token.refresh_token,
            },
          );
        }
        return;
      }
      if (storage === 'credential-store') {
        try {
          writeSystemCredentials();
        } catch (error) {
          if (!dbPath || !fs.existsSync(dbPath)) {
            throw error;
          }
          logger.warn('Keychain write failed; using the existing client state database');
          backupMacOSClientDatabase(dbPath);
          try {
            writeMacOSClientDatabase(dbPath, credentials);
          } catch {
            // An existing database makes this fallback non-fatal.
          }
          syncMachineId(dbPath);
        }
        return;
      }
      if (!dbPath) {
        throw new Error('Failed to locate database path');
      }
      backupMacOSClientDatabase(dbPath);
      writeMacOSClientDatabase(dbPath, credentials);
      syncMachineId(dbPath);
    },
  };
}
