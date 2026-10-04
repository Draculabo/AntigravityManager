import fs from 'node:fs';
import { encrypt, decrypt, initializeMasterKey } from '@/shared/security/security';
import { isEncryptedPayloadCandidate } from '@/shared/security/crypto';
import { writePrivateFileAtomically } from '@/shared/persistence/privateFile';
import type { AccountBackupData } from '../types';
import { parseAccountBackup } from './snapshotCredentials';

/** New local snapshots use the existing master key; historical JSON is read without overwriting it. */
export async function readAccountBackupFile(file: string): Promise<AccountBackupData> {
  const content = await fs.promises.readFile(file, 'utf-8');
  if (isEncryptedPayloadCandidate(content)) {
    await initializeMasterKey({ encryptedSamples: [content] });
  }
  const plaintext = isEncryptedPayloadCandidate(content) ? await decrypt(content) : content;
  return parseAccountBackup(plaintext);
}

/** Plaintext cloud storage no longer initializes the key needed by local snapshots. */
export async function initializeAccountBackupKey(files: readonly string[]): Promise<void> {
  const encryptedSamples: string[] = [];
  for (const file of files) {
    if (!fs.existsSync(file)) {
      continue;
    }
    const content = await fs.promises.readFile(file, 'utf8');
    if (isEncryptedPayloadCandidate(content)) {
      encryptedSamples.push(content);
    }
  }
  await initializeMasterKey({ encryptedSamples });
}

export async function writeAccountBackupFile(
  file: string,
  backup: AccountBackupData,
): Promise<void> {
  const payload = await encrypt(JSON.stringify(backup));
  writePrivateFileAtomically(file, payload);
}
