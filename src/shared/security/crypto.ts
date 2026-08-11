import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
export const ENCRYPTED_PAYLOAD_VERSION_PREFIX = 'agm_enc_v1:';

export interface ParsedEncryptedPayload {
  authTagHex: string;
  encryptedHex: string;
  isVersioned: boolean;
  ivHex: string;
}

export function parseEncryptedPayload(text: string): ParsedEncryptedPayload | null {
  const isVersioned = text.startsWith(ENCRYPTED_PAYLOAD_VERSION_PREFIX);
  const payload = isVersioned ? text.slice(ENCRYPTED_PAYLOAD_VERSION_PREFIX.length) : text;
  const parts = payload.split(':');
  if (parts.length !== 3) {
    return null;
  }

  const [ivHex, authTagHex, encryptedHex] = parts;
  if (
    !/^[a-f0-9]+$/i.test(ivHex) ||
    !/^[a-f0-9]+$/i.test(authTagHex) ||
    !/^[a-f0-9]+$/i.test(encryptedHex)
  ) {
    return null;
  }

  return { authTagHex, encryptedHex, isVersioned, ivHex };
}

export function isEncryptedPayloadCandidate(text: string | null): text is string {
  if (!text || text.startsWith('{') || text.startsWith('[')) {
    return false;
  }

  return text.startsWith(ENCRYPTED_PAYLOAD_VERSION_PREFIX) || text.split(':').length === 3;
}

export function encryptWithKey(key: Buffer, text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);

  return `${ENCRYPTED_PAYLOAD_VERSION_PREFIX}${iv.toString('hex')}:${cipher
    .getAuthTag()
    .toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decryptParsedPayloadWithKey(key: Buffer, payload: ParsedEncryptedPayload): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(payload.ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(payload.authTagHex, 'hex'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.encryptedHex, 'hex')),
    decipher.final(),
  ]);

  return plaintext.toString('utf8');
}

export function canDecryptPayloadWithKey(text: string, key: Buffer): boolean {
  const payload = parseEncryptedPayload(text);
  if (!payload) {
    return false;
  }

  try {
    decryptParsedPayloadWithKey(key, payload);
    return true;
  } catch {
    return false;
  }
}
