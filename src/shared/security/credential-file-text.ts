import { isEncryptedPayloadCandidate } from './crypto';

/** Plain JSON is portable; only historical ciphertext requires the original machine key. */
export async function decodeCredentialFileText(content: string): Promise<string> {
  if (!isEncryptedPayloadCandidate(content)) {
    return content;
  }
  const { initializeMasterKey, decrypt } = await import('./security');
  await initializeMasterKey({ encryptedSamples: [content] });
  return decrypt(content);
}

/** Parse persisted credential JSON without including secret fragments in syntax errors. */
export async function decodeCredentialFileJson(content: string): Promise<unknown> {
  const plaintext = await decodeCredentialFileText(content);
  try {
    return JSON.parse(plaintext);
  } catch {
    throw new Error('Credential backup contains invalid JSON');
  }
}
