import os from 'os';
import path from 'path';

/**
 * Lazy-loaded Electron bindings. Modules under src/utils, src/services, and the
 * NestJS proxy import via this shim so they can run both inside Electron and as
 * a plain Node.js server (no Electron present).
 */

type ElectronAppLike = {
  getPath: (name: string) => string;
  getAppPath: () => string;
  getName?: () => string;
  isPackaged?: boolean;
};

type SafeStorageLike = {
  isEncryptionAvailable: () => boolean;
  encryptString: (text: string) => Buffer;
  decryptString: (encrypted: Buffer) => string;
};

let cachedElectronModule: typeof import('electron') | null | undefined;

function loadElectron(): typeof import('electron') | null {
  if (cachedElectronModule !== undefined) {
    return cachedElectronModule;
  }
  if (!process.versions.electron) {
    cachedElectronModule = null;
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedElectronModule = require('electron');
    return cachedElectronModule;
  } catch {
    cachedElectronModule = null;
    return null;
  }
}

export function isElectronRuntime(): boolean {
  return Boolean(process.versions.electron) && loadElectron() !== null;
}

/**
 * The base directory for non-Electron deployments. Mirrors what
 * `app.getPath('userData')` would have returned. Override with
 * `AGM_DATA_DIR` to relocate state on a server.
 */
export function getServerUserDataPath(): string {
  const fromEnv = process.env.AGM_DATA_DIR?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return path.join(os.homedir(), '.antigravity-manager-server');
}

export function getElectronApp(): ElectronAppLike | null {
  const electron = loadElectron();
  if (!electron?.app) {
    return null;
  }
  return electron.app as ElectronAppLike;
}

export function getElectronSafeStorage(): SafeStorageLike | null {
  const electron = loadElectron();
  if (!electron?.safeStorage) {
    return null;
  }
  return electron.safeStorage as SafeStorageLike;
}
