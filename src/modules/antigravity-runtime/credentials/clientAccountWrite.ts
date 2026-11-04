import fs from 'node:fs';
import path from 'node:path';
import type { AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import { resolveAntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import { getAntigravityDbPaths, type PathResolutionOptions } from '@/shared/platform/paths';
import {
  compareVersion,
  getAntigravityVersion,
  isCredentialStoreVersion,
} from '../utils/antigravityVersion';
import { logger } from '@/shared/logging/logger';
import { prepareClientAccountCredentials, type ClientAccountCredentials } from './clientAccount';
import { createClientSqliteWriter, validateClientSqliteDestination } from './clientSqlite';
import {
  readAntigravityCredentialStoreToken,
  writeAntigravityCredentialStoreToken,
} from './antigravityCredentialStore';
import { buildAntigravityCredentialPayload } from './antigravityCredentialPayload';
import { writeAgyCliToken } from './agyCliTokenStore';
import { writeGoogleOAuthCredentials } from './googleOAuthCredentialStore';
import { prepareMacOSClientAccountWrite } from './macosClientAccountWrite';
import { CredentialReadbackError } from '@/shared/auth/credentialReadbackError';
import { prepareWindowsIdeRecovery } from './windowsIdeRecovery';
import { validateIdeStandaloneDestination, writeIdeStandaloneToken } from './ideStandaloneToken';
import { prepareLinuxIdeRecovery } from './linuxIdeRecovery';
import { writeLinuxIdeCredentialPayload } from './linuxIdeCredentialStore';
import {
  buildMacOSIdeCredentialPayload,
  syncMacOSIdeCredentialFiles,
  writeMacOSKeychainPayload,
} from './macosCredentialStore';
import { writeMacOSServiceMachineId } from './macosClientSqlite';

export type ClientAccountStorage = 'cli-session' | 'credential-store' | 'sqlite';

export interface PreparedClientAccountWrite {
  readonly storage: ClientAccountStorage;
  readonly write: () => Promise<void>;
}

export async function resolveClientAccountStorage(
  appTarget?: AntigravityAppTarget,
  pathOptions?: PathResolutionOptions,
): Promise<ClientAccountStorage> {
  const target = resolveAntigravityAppTarget(appTarget);
  if (target === 'agy') {
    return process.platform === 'darwin' ? 'credential-store' : 'cli-session';
  }
  if (target === 'ide') {
    if (['win32', 'linux', 'darwin'].includes(process.platform)) {
      try {
        const version = await getAntigravityVersion(target, pathOptions?.executablePath);
        return compareVersion(version.shortVersion, '2.6.0') >= 0 ? 'credential-store' : 'sqlite';
      } catch {
        // Unknown IDE versions retain the established SQLite destination.
      }
    }
    return 'sqlite';
  }
  try {
    const version = await getAntigravityVersion(target, pathOptions?.executablePath);
    return isCredentialStoreVersion(version) ? 'credential-store' : 'sqlite';
  } catch {
    const existingDatabase = getAntigravityDbPaths(target, pathOptions).some((file) =>
      fs.existsSync(file),
    );
    logger.warn('Client version is unavailable; selecting storage from the resolved installation', {
      target,
      storage: existingDatabase ? 'sqlite' : 'credential-store',
    });
    return existingDatabase ? 'sqlite' : 'credential-store';
  }
}

/** Resolves the destination once, before closing the application or changing account state. */
export async function prepareClientAccountWrite(
  input: ClientAccountCredentials,
  appTarget?: AntigravityAppTarget,
  pathOptions?: PathResolutionOptions,
  purpose: 'account-switch' | 'workspace' = 'account-switch',
): Promise<PreparedClientAccountWrite> {
  const target = resolveAntigravityAppTarget(appTarget);
  const storage =
    (process.platform === 'linux' || process.platform === 'darwin') &&
    target === 'ide' &&
    purpose === 'workspace'
      ? 'sqlite'
      : await resolveClientAccountStorage(target, pathOptions);
  const syncIde =
    ['win32', 'linux', 'darwin'].includes(process.platform) &&
    target === 'ide' &&
    storage === 'credential-store' &&
    purpose === 'account-switch';
  if (process.platform === 'darwin' && !syncIde) {
    return prepareMacOSClientAccountWrite(input, target, storage, pathOptions);
  }
  const credentials = prepareClientAccountCredentials(input);
  if (target === 'agy') {
    const payload = buildAntigravityCredentialPayload(credentials.token);
    return {
      storage,
      write: async () => {
        writeAgyCliToken(payload);
        writeGoogleOAuthCredentials({ ...credentials.token, email: credentials.email });
      },
    };
  }
  let writeSqlite: (() => Promise<void>) | undefined;
  let saveRecovery: (() => Promise<void>) | undefined;
  let database: string | undefined;
  if (storage === 'sqlite' || syncIde) {
    const paths = getAntigravityDbPaths(target, pathOptions);
    const dbPath = paths.find((file) => fs.existsSync(file)) ?? paths[0];
    if (!dbPath) {
      throw new Error('Selected client has no state database path');
    }
    let writablePath = fs.existsSync(dbPath) ? dbPath : path.dirname(dbPath);
    while (!fs.existsSync(writablePath)) {
      const parent = path.dirname(writablePath);
      if (parent === writablePath) {
        throw new Error('Client state directory is unavailable');
      }
      writablePath = parent;
    }
    fs.accessSync(writablePath, fs.constants.W_OK);
    if (fs.existsSync(dbPath)) {
      fs.accessSync(path.dirname(dbPath), fs.constants.W_OK);
    }
    validateClientSqliteDestination(dbPath);
    database = dbPath;
    writeSqlite = createClientSqliteWriter(dbPath, credentials);
    if (syncIde && process.platform !== 'darwin') {
      validateIdeStandaloneDestination();
      saveRecovery =
        process.platform === 'linux'
          ? await prepareLinuxIdeRecovery(dbPath)
          : await prepareWindowsIdeRecovery(dbPath);
    }
  }
  if (storage === 'credential-store') {
    return {
      storage,
      write: async () => {
        // The switch owner calls this only after the captured IDE tree has exited.
        await saveRecovery?.();
        await writeSqlite?.();
        if (syncIde && process.platform === 'darwin') {
          if (database && credentials.serviceMachineId !== undefined) {
            try {
              writeMacOSServiceMachineId(database, credentials.serviceMachineId);
            } catch {
              logger.warn('Failed to synchronize macOS IDE service machine identity');
            }
          }
          const payload = buildMacOSIdeCredentialPayload(credentials);
          try {
            writeMacOSKeychainPayload(payload);
          } catch {
            logger.warn('Failed to write macOS IDE Keychain credentials');
          }
          try {
            syncMacOSIdeCredentialFiles(credentials, payload);
          } catch {
            logger.warn('Failed to synchronize macOS IDE credential files');
          }
          return;
        }
        if (syncIde && process.platform === 'linux') {
          await writeLinuxIdeCredentialPayload(
            buildAntigravityCredentialPayload(credentials.token),
          );
          writeIdeStandaloneToken(credentials.token);
          return;
        }
        await writeAntigravityCredentialStoreToken(
          credentials.token,
          target === 'classic' ? { syncClassicOAuthFile: true } : {},
        );
        const written = await readAntigravityCredentialStoreToken();
        if (
          !written ||
          written.accessToken !== credentials.token.access_token ||
          written.refreshToken !== credentials.token.refresh_token ||
          written.expiryTimestamp !== credentials.token.expiry_timestamp ||
          written.idToken !== (credentials.token.id_token || undefined) ||
          written.projectId !== (credentials.token.project_id || undefined)
        ) {
          throw new CredentialReadbackError(
            'Client credential-store write could not be confirmed',
            {
              accessToken: written?.accessToken === credentials.token.access_token,
              refreshToken: written?.refreshToken === credentials.token.refresh_token,
              expiry: written?.expiryTimestamp === credentials.token.expiry_timestamp,
              idToken: written?.idToken === (credentials.token.id_token || undefined),
              projectId: written?.projectId === (credentials.token.project_id || undefined),
            },
          );
        }
        if (syncIde) {
          writeIdeStandaloneToken(credentials.token);
        }
      },
    };
  }
  if (!writeSqlite) {
    throw new Error('Selected client has no prepared account writer');
  }
  return { storage, write: writeSqlite };
}
