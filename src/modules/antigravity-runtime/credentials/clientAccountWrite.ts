import fs from 'node:fs';
import path from 'node:path';
import type { AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import { resolveAntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import { getAntigravityDbPaths, type PathResolutionOptions } from '@/shared/platform/paths';
import { getAntigravityVersion, isCredentialStoreVersion } from '../utils/antigravityVersion';
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
): Promise<PreparedClientAccountWrite> {
  const credentials =
    process.platform === 'darwin' ? input : prepareClientAccountCredentials(input);
  const target = resolveAntigravityAppTarget(appTarget);
  const storage = await resolveClientAccountStorage(target, pathOptions);
  if (process.platform === 'darwin') {
    return prepareMacOSClientAccountWrite(input, target, storage, pathOptions);
  }
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
  if (storage === 'credential-store') {
    return {
      storage,
      write: async () => {
        await writeAntigravityCredentialStoreToken(credentials.token, {
          syncClassicOAuthFile: true,
        });
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
      },
    };
  }
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
  return { storage, write: createClientSqliteWriter(dbPath, credentials) };
}
