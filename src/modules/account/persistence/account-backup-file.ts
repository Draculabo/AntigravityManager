import fs from 'node:fs';
import { encrypt, decrypt } from '@/shared/security/security';
import { isEncryptedPayloadCandidate } from '@/shared/security/crypto';
import { writePrivateFileAtomically } from '@/shared/persistence/privateFile';
import type { AccountBackupData } from '../types';
import { parseAccountBackup } from './snapshotCredentials';

/** New local snapshots use the existing master key; historical JSON is read without overwriting it. */
export async function readAccountBackupFile(file: string): Promise<AccountBackupData> {
  const content = await fs.promises.readFile(file, 'utf-8');
  const plaintext = isEncryptedPayloadCandidate(content) ? await decrypt(content) : content;
  return parseAccountBackup(plaintext);
}

export async function writeAccountBackupFile(
  file: string,
  backup: AccountBackupData,
): Promise<void> {
  const payload = await encrypt(JSON.stringify(backup));
  writePrivateFileAtomically(file, payload);
}
