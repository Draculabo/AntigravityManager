import crypto from 'crypto';
import { logger } from './logger';
import { safeStorage, app } from 'electron';
import path from 'path';
import fs from 'fs/promises';

const SERVICE_NAME = 'AntigravityManager';
const ACCOUNT_NAME = 'MasterKey';
const KEYCHAIN_ERROR_CODE = 'ERR_KEYCHAIN_UNAVAILABLE';
const KEYCHAIN_HINT_TRANSLOCATION = 'HINT_APP_TRANSLOCATION';
const KEYCHAIN_HINT_KEYCHAIN_DENIED = 'HINT_KEYCHAIN_DENIED';
const KEYCHAIN_HINT_SIGN_NOTARIZE = 'HINT_SIGN_NOTARIZE';
const DATA_MIGRATION_ERROR_CODE = 'ERR_DATA_MIGRATION_FAILED';
const DATA_MIGRATION_HINT_RELOGIN = 'HINT_RELOGIN';

export type KeySource = 'safeStorage' | 'keytar' | 'file';

interface MasterKeyState {
  key: Buffer;
  source: KeySource;
}

// Cache the key in memory to avoid frequent system calls
let cachedMasterKey: Buffer | null = null;
let cachedMasterKeySource: KeySource | null = null;

function cacheMasterKey(key: Buffer, source: KeySource) {
  cachedMasterKey = key;
  cachedMasterKeySource = source;
}

function getCachedMasterKey() {
  if (!cachedMasterKey || !cachedMasterKeySource) {
    return null;
  }

  return { key: cachedMasterKey, source: cachedMasterKeySource };
}

function buildKeychainAccessHint(error: unknown): string | null {
  if (process.platform !== 'darwin') {
    return null;
  }

  let appPath = '';
  try {
    appPath = app.getAppPath();
  } catch {
    appPath = '';
  }

  const isTranslocated = appPath.includes('/AppTranslocation/');
  if (isTranslocated) {
    return KEYCHAIN_HINT_TRANSLOCATION;
  }

  const errorMessage = error instanceof Error ? error.message : String(error);
  if (errorMessage.toLowerCase().includes('keychain')) {
    return KEYCHAIN_HINT_KEYCHAIN_DENIED;
  }

  return KEYCHAIN_HINT_SIGN_NOTARIZE;
}

// Lock to prevent concurrent key generation
let keyGenerationInProgress: Promise<MasterKeyState> | null = null;

// Fallback key file path (used when keytar and safeStorage both fail)
function getFallbackKeyPath(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, '.mk');
}

/**
 * Try to load keytar dynamically to avoid hard failure if it's not available
 */
async function tryKeytar(): Promise<typeof import('keytar') | null> {
  try {
    // Native modules may fail to load in production builds
    const keytar = await import('keytar');
    // Test if keytar is actually working by calling a method
    await keytar.default.findCredentials(SERVICE_NAME);
    return keytar.default;
  } catch (error) {
    logger.warn('Security: keytar not available, using fallback', error);
    return null;
  }
}

async function readSafeStorageKey(keyPath: string): Promise<Buffer | null> {
  if (!safeStorage.isEncryptionAvailable()) {
    return null;
  }

  try {
    const encryptedKey = await fs.readFile(keyPath);
    const hexKey = safeStorage.decryptString(encryptedKey);

    if (!/^[a-f0-9]+$/i.test(hexKey) || hexKey.length !== 64) {
      return null;
    }

    return Buffer.from(hexKey, 'hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    logger.warn('Security: Failed to read safeStorage key file', error);
    return null;
  }
}

async function getOrCreateSafeStorageKey(
  keyPath: string,
): Promise<{ key: Buffer; created: boolean }> {
  const existingKey = await readSafeStorageKey(keyPath);
  if (existingKey) {
    return { key: existingKey, created: false };
  }

  const buffer = crypto.randomBytes(32);
  const hexKey = buffer.toString('hex');
  const encrypted = safeStorage.encryptString(hexKey);
  await atomicWriteFile(keyPath, encrypted, { mode: 0o600 });
  return { key: buffer, created: true };
}

async function readKeytarKey(): Promise<Buffer | null> {
  const keytar = await tryKeytar();
  if (!keytar) {
    return null;
  }

  const existingKey = await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME);
  if (!existingKey) {
    return null;
  }

  if (!/^[a-f0-9]+$/i.test(existingKey) || existingKey.length !== 64) {
    logger.warn('Security: keytar key has unexpected format');
    return null;
  }

  return Buffer.from(existingKey, 'hex');
}

async function getOrCreateKeytarKey(): Promise<{ key: Buffer; created: boolean } | null> {
  const keytar = await tryKeytar();
  if (!keytar) {
    return null;
  }

  const existingKey = await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME);
  if (existingKey) {
    return { key: Buffer.from(existingKey, 'hex'), created: false };
  }

  const buffer = crypto.randomBytes(32);
  const hexKey = buffer.toString('hex');
  await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, hexKey);
  return { key: buffer, created: true };
}

async function readFileFallbackKey(keyPath: string): Promise<Buffer | null> {
  try {
    const content = await fs.readFile(keyPath, 'utf8');
    if (content.length === 64 && /^[a-f0-9]+$/i.test(content)) {
      return Buffer.from(content, 'hex');
    }

    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    logger.warn('Security: Error reading fallback key file', error);
    return null;
  }
}

async function getOrCreateFileFallbackKey(
  keyPath: string,
): Promise<{ key: Buffer; created: boolean }> {
  const existingKey = await readFileFallbackKey(keyPath);
  if (existingKey) {
    return { key: existingKey, created: false };
  }

  const buffer = crypto.randomBytes(32);
  const hexKey = buffer.toString('hex');
  await atomicWriteFile(keyPath, hexKey, { mode: 0o600 });
  return { key: buffer, created: true };
}

async function getFallbackMasterKeys(
  keyPath: string,
  primarySource: KeySource,
): Promise<MasterKeyState[]> {
  const fallbackKeys: MasterKeyState[] = [];

  if (primarySource !== 'keytar') {
    const keytarKey = await readKeytarKey();
    if (keytarKey) {
      fallbackKeys.push({ key: keytarKey, source: 'keytar' });
    }
  }

  if (primarySource !== 'file') {
    const fileKey = await readFileFallbackKey(keyPath);
    if (fileKey) {
      fallbackKeys.push({ key: fileKey, source: 'file' });
    }
  }

  if (primarySource !== 'safeStorage') {
    const safeStorageKey = await readSafeStorageKey(keyPath);
    if (safeStorageKey) {
      fallbackKeys.push({ key: safeStorageKey, source: 'safeStorage' });
    }
  }

  return fallbackKeys;
}

/**
 * Atomic file write to prevent data races
 * Writes to a temp file first, then renames atomically
 */
async function atomicWriteFile(
  filePath: string,
  data: Buffer | string,
  options?: { mode?: number },
): Promise<void> {
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    await fs.writeFile(tempPath, data, { mode: options?.mode ?? 0o600 });
    await fs.rename(tempPath, filePath);
  } catch (error) {
    // Clean up temp file if rename failed
    try {
      await fs.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Get or generate master encryption key using multiple fallback strategies:
 * 1. safeStorage (Electron's built-in secure storage) - preferred
 * 2. keytar (system keychain) - fallback
 * 3. File-based with safeStorage encryption - last resort (with security warning)
 *
 * Uses a lock to prevent concurrent key generation (data race prevention)
 */
async function getPrimaryMasterKey(): Promise<MasterKeyState> {
  const cached = getCachedMasterKey();
  if (cached) {
    return cached;
  }

  if (keyGenerationInProgress) {
    return keyGenerationInProgress;
  }

  keyGenerationInProgress = generatePrimaryMasterKey();
  try {
    return await keyGenerationInProgress;
  } finally {
    keyGenerationInProgress = null;
  }
}

async function generatePrimaryMasterKey(): Promise<MasterKeyState> {
  const cached = getCachedMasterKey();
  if (cached) {
    return cached;
  }

  const keyPath = getFallbackKeyPath();

  if (safeStorage.isEncryptionAvailable()) {
    try {
      const result = await getOrCreateSafeStorageKey(keyPath);
      cacheMasterKey(result.key, 'safeStorage');
      if (result.created) {
        logger.info('Security: Generated new master key via safeStorage');
      } else {
        logger.info('Security: Loaded master key via safeStorage');
      }
      return { key: result.key, source: 'safeStorage' };
    } catch (error) {
      logger.warn('Security: safeStorage failed, trying keytar', error);
    }
  }

  try {
    const result = await getOrCreateKeytarKey();
    if (result) {
      cacheMasterKey(result.key, 'keytar');
      if (result.created) {
        logger.info('Security: Generated new master key via keytar');
      } else {
        logger.info('Security: Loaded master key via keytar');
      }
      return { key: result.key, source: 'keytar' };
    }
  } catch (error) {
    logger.warn('Security: keytar failed', error);
  }

  logger.warn(
    'Security: WARNING - Using file-based key storage. ' +
      'This is less secure than system keychain. ' +
      'Ensure the app data directory has restricted permissions.',
  );

  try {
    const result = await getOrCreateFileFallbackKey(keyPath);
    cacheMasterKey(result.key, 'file');
    if (result.created) {
      logger.warn('Security: Generating file-based fallback key (less secure)');
    } else {
      logger.warn('Security: Using file-based fallback key (less secure)');
    }
    return { key: result.key, source: 'file' };
  } catch (error) {
    const hint = buildKeychainAccessHint(error);
    logger.error('Security: Failed to access keychain/credential manager', error);
    const message = hint ? `${KEYCHAIN_ERROR_CODE}|${hint}` : KEYCHAIN_ERROR_CODE;
    throw new Error(message);
  }
}

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

/**
 * Encrypts a string using AES-256-GCM.
 * Output format: "iv_hex:auth_tag_hex:ciphertext_hex"
 */
export async function encrypt(text: string): Promise<string> {
  try {
    const { key } = await getPrimaryMasterKey();
    return encryptWithKey(key, text);
  } catch (error) {
    logger.error('Security: Encryption failed', error);
    throw new Error('Encryption failed');
  }
}

function encryptWithKey(key: Buffer, text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

function decryptWithKey(
  key: Buffer,
  ivHex: string,
  authTagHex: string,
  encryptedHex: string,
): string {
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

function isAuthTagMismatchError(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  return (
    normalized.includes('unable to authenticate data') ||
    normalized.includes('auth tag') ||
    normalized.includes('bad decrypt')
  );
}

export async function decryptWithMigration(
  text: string,
): Promise<{ value: string; reencrypted?: string; usedFallback?: KeySource }> {
  if (text.startsWith('{') || text.startsWith('[')) {
    return { value: text };
  }

  const parts = text.split(':');
  if (parts.length !== 3) {
    return { value: text };
  }

  const [ivHex, authTagHex, encryptedHex] = parts;

  if (
    !/^[a-f0-9]+$/i.test(ivHex) ||
    !/^[a-f0-9]+$/i.test(authTagHex) ||
    !/^[a-f0-9]+$/i.test(encryptedHex)
  ) {
    logger.warn('Security: Invalid encrypted format - not valid hex');
    throw new Error('Invalid encrypted data format');
  }

  const primary = await getPrimaryMasterKey();
  try {
    return { value: decryptWithKey(primary.key, ivHex, authTagHex, encryptedHex) };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (errorMessage.includes('Invalid key length') || errorMessage.includes('Invalid IV length')) {
      logger.error('Security: Decryption failed - corrupted encrypted data');
      throw new Error('Decryption failed: Corrupted encrypted data');
    }

    if (!isAuthTagMismatchError(errorMessage)) {
      logger.error('Security: Decryption failed', error);
      throw new Error('Decryption failed');
    }

    const keyPath = getFallbackKeyPath();
    const fallbackKeys = await getFallbackMasterKeys(keyPath, primary.source);
    for (const fallback of fallbackKeys) {
      try {
        const value = decryptWithKey(fallback.key, ivHex, authTagHex, encryptedHex);
        let reencrypted: string | undefined;
        try {
          reencrypted = encryptWithKey(primary.key, value);
        } catch (reencryptError) {
          logger.warn(
            `Security: Failed to re-encrypt data from ${fallback.source} to ${primary.source}`,
            reencryptError,
          );
        }
        if (reencrypted) {
          logger.info(
            `Security: Re-encrypted data from ${fallback.source} to ${primary.source}`,
          );
        }
        return { value, reencrypted, usedFallback: fallback.source };
      } catch {
        continue;
      }
    }

    logger.error(
      'Security: Decryption failed - authentication tag mismatch (wrong key or corrupted data)',
    );
    throw new Error(`${DATA_MIGRATION_ERROR_CODE}|${DATA_MIGRATION_HINT_RELOGIN}`);
  }
}

/**
 * Decrypts a string using AES-256-GCM.
 * Input format: "iv_hex:auth_tag_hex:ciphertext_hex"
 */
export async function decrypt(text: string): Promise<string> {
  const result = await decryptWithMigration(text);
  return result.value;
}
