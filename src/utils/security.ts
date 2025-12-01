import keytar from 'keytar';
import crypto from 'crypto';
import { logger } from './logger';

const SERVICE_NAME = 'AntigravityManager';
const ACCOUNT_NAME = 'MasterKey';

// Cache the key in memory to avoid frequent system calls
let cachedMasterKey: Buffer | null = null;

async function getOrGenerateMasterKey(): Promise<Buffer> {
  if (cachedMasterKey) return cachedMasterKey;

  try {
    let hexKey = await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME);

    if (!hexKey) {
      logger.info('Security: Generating new master key...');
      // Generate 256-bit key (32 bytes)
      const buffer = crypto.randomBytes(32);
      hexKey = buffer.toString('hex');
      await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, hexKey);
    }

    cachedMasterKey = Buffer.from(hexKey, 'hex');
    return cachedMasterKey;
  } catch (error) {
    logger.error('Security: Failed to access keychain/credential manager', error);
    // Fallback? If we can't store the key, we can't persistently encrypt.
    // For now, throw to prevent data loss (better not to write than to write something we can't decrypt later or write plain text when promised encrypted)
    throw new Error('Key management system unavailable');
  }
}

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

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
    throw error;
  }
}

/**
 * Decrypts a string using AES-256-GCM.
 * Input format: "iv_hex:auth_tag_hex:ciphertext_hex"
 */
export async function decrypt(text: string): Promise<string> {
  // Check if it's plain text (JSON) for backward compatibility
  // Very rough check: starts with { or [
  if (text.startsWith('{') || text.startsWith('[')) {
    return text;
  }

  // Also checking if it follows our pattern
  const parts = text.split(':');
  if (parts.length !== 3) {
    // Treat as plain text if it doesn't look like our encrypted format
    return text;
  }

  try {
    const key = await getOrGenerateMasterKey();

    const [ivHex, authTagHex, encryptedHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    logger.error('Security: Decryption failed', error);
    // If decryption fails, it might be corrupted or using a different key.
    throw error;
  }
}
