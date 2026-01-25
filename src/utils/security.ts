import crypto from 'crypto';
import { logger } from './logger';
import { safeStorage, app } from 'electron';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';

const SERVICE_NAME = 'AntigravityManager';
const ACCOUNT_NAME = 'MasterKey';

// Cache the key in memory to avoid frequent system calls
let cachedMasterKey: Buffer | null = null;

// Lock to prevent concurrent key generation
let keyGenerationInProgress: Promise<Buffer> | null = null;

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

/**
 * Atomic file write to prevent data races
 * Writes to a temp file first, then renames atomically
 */
async function atomicWriteFile(filePath: string, data: Buffer | string, options?: { mode?: number }): Promise<void> {
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
async function getOrGenerateMasterKey(): Promise<Buffer> {
  // Return cached key if available
  if (cachedMasterKey) return cachedMasterKey;

  // Prevent concurrent key generation
  if (keyGenerationInProgress) {
    return keyGenerationInProgress;
  }

  keyGenerationInProgress = generateMasterKeyInternal();
  try {
    return await keyGenerationInProgress;
  } finally {
    keyGenerationInProgress = null;
  }
}

async function generateMasterKeyInternal(): Promise<Buffer> {
  // Double-check cache after acquiring lock
  if (cachedMasterKey) return cachedMasterKey;

  const keyPath = getFallbackKeyPath();

  // Strategy 1: Try safeStorage (Electron's secure storage) - PREFERRED
  if (safeStorage.isEncryptionAvailable()) {
    try {
      try {
        const encryptedKey = await fs.readFile(keyPath);
        const hexKey = safeStorage.decryptString(encryptedKey);
        cachedMasterKey = Buffer.from(hexKey, 'hex');
        logger.info('Security: Loaded master key via safeStorage');
        return cachedMasterKey;
      } catch (readError) {
        // File doesn't exist or can't be read - generate new key
        if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn('Security: Error reading key file, regenerating', readError);
        }
        
        const buffer = crypto.randomBytes(32);
        const hexKey = buffer.toString('hex');
        const encrypted = safeStorage.encryptString(hexKey);
        await atomicWriteFile(keyPath, encrypted, { mode: 0o600 });
        cachedMasterKey = buffer;
        logger.info('Security: Generated new master key via safeStorage');
        return cachedMasterKey;
      }
    } catch (error) {
      logger.warn('Security: safeStorage failed, trying keytar', error);
    }
  }

  // Strategy 2: Try keytar (system keychain)
  try {
    const keytar = await tryKeytar();
    if (keytar) {
      const existingKey = await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME);

      if (existingKey) {
        cachedMasterKey = Buffer.from(existingKey, 'hex');
        logger.info('Security: Loaded master key via keytar');
        return cachedMasterKey;
      }

      // Generate new key
      logger.info('Security: Generating new master key via keytar...');
      const buffer = crypto.randomBytes(32);
      const hexKey = buffer.toString('hex');
      await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, hexKey);
      cachedMasterKey = buffer;
      return cachedMasterKey;
    }
  } catch (error) {
    logger.warn('Security: keytar failed', error);
  }

  // Strategy 3: File-based fallback (LESS SECURE - warn user)
  // This is only used when both safeStorage and keytar fail
  logger.warn(
    'Security: WARNING - Using file-based key storage. ' +
    'This is less secure than system keychain. ' +
    'Ensure the app data directory has restricted permissions.'
  );
  
  try {
    try {
      const content = await fs.readFile(keyPath, 'utf8');
      if (content.length === 64 && /^[a-f0-9]+$/i.test(content)) {
        cachedMasterKey = Buffer.from(content, 'hex');
        logger.warn('Security: Using file-based fallback key (less secure)');
        return cachedMasterKey;
      }
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('Security: Error reading fallback key file', readError);
      }
    }
    
    // Generate new fallback key with atomic write
    logger.warn('Security: Generating file-based fallback key (safeStorage and keytar unavailable)');
    const buffer = crypto.randomBytes(32);
    const hexKey = buffer.toString('hex');
    await atomicWriteFile(keyPath, hexKey, { mode: 0o600 });
    cachedMasterKey = buffer;
    return cachedMasterKey;
  } catch (error) {
    logger.error('Security: All key storage methods failed', error);
    throw new SecurityError('Key management system unavailable', 'KEY_STORAGE_FAILED');
  }
}

// Custom error class for better error categorization
export class SecurityError extends Error {
  constructor(message: string, public readonly code: SecurityErrorCode) {
    super(message);
    this.name = 'SecurityError';
  }
}

export type SecurityErrorCode = 
  | 'KEY_STORAGE_FAILED'
  | 'ENCRYPTION_FAILED'
  | 'DECRYPTION_FAILED'
  | 'INVALID_FORMAT'
  | 'AUTH_TAG_MISMATCH'
  | 'CORRUPTED_DATA';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

/**
 * Encrypts a string using AES-256-GCM.
 * Output format: "iv_hex:auth_tag_hex:ciphertext_hex"
 */
export async function encrypt(text: string): Promise<string> {
  try {
    const key = await getOrGenerateMasterKey();
    const iv = crypto.randomBytes(IV_LENGTH);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    // Format: iv:authTag:encrypted
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  } catch (error) {
    logger.error('Security: Encryption failed', error);
    if (error instanceof SecurityError) throw error;
    throw new SecurityError('Encryption failed', 'ENCRYPTION_FAILED');
  }
}

/**
 * Decrypts a string using AES-256-GCM.
 * Input format: "iv_hex:auth_tag_hex:ciphertext_hex"
 * 
 * @throws {SecurityError} With specific error codes for different failure types
 */
export async function decrypt(text: string): Promise<string> {
  // Check if it's plain text (JSON) for backward compatibility
  if (text.startsWith('{') || text.startsWith('[')) {
    return text;
  }

  // Validate encrypted format
  const parts = text.split(':');
  if (parts.length !== 3) {
    // Treat as plain text if it doesn't look like our encrypted format
    return text;
  }

  const [ivHex, authTagHex, encryptedHex] = parts;

  // Validate hex format
  if (!/^[a-f0-9]+$/i.test(ivHex) || !/^[a-f0-9]+$/i.test(authTagHex) || !/^[a-f0-9]+$/i.test(encryptedHex)) {
    logger.warn('Security: Invalid encrypted format - not valid hex');
    throw new SecurityError('Invalid encrypted data format', 'INVALID_FORMAT');
  }

  try {
    const key = await getOrGenerateMasterKey();

    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    // Categorize the error for better diagnostics
    if (errorMessage.includes('Unsupported state or unable to authenticate data')) {
      logger.error('Security: Decryption failed - authentication tag mismatch (wrong key or corrupted data)');
      throw new SecurityError(
        'Decryption failed: Data was encrypted with a different key or is corrupted',
        'AUTH_TAG_MISMATCH'
      );
    }
    
    if (errorMessage.includes('Invalid key length') || errorMessage.includes('Invalid IV length')) {
      logger.error('Security: Decryption failed - corrupted encrypted data');
      throw new SecurityError('Decryption failed: Corrupted encrypted data', 'CORRUPTED_DATA');
    }

    logger.error('Security: Decryption failed', error);
    throw new SecurityError('Decryption failed', 'DECRYPTION_FAILED');
  }
}
