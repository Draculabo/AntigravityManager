import fs from 'node:fs';
import { decodeCredentialFileText } from '@/shared/security/credential-file-text';
import { isEncryptedPayloadCandidate } from '@/shared/security/crypto';
import { writePrivateFileAtomically } from '@/shared/persistence/privateFile';
import type { AccountBackupData } from '../types';
import { parseAccountBackup } from './snapshotCredentials';
import { preserveAccountMigrationBackups } from './account-migration-backup';

/** Validate before migrating; preserve exact decoded fields and never overwrite a newer capture. */
async function readSnapshot(file: string, content: string): Promise<AccountBackupData> {
  const plaintext = await decodeCredentialFileText(content);
  const backup = parseAccountBackup(plaintext);
  if (isEncryptedPayloadCandidate(content)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Account snapshot migration requires a regular file');
    }
    const current = fs.readFileSync(file, 'utf8');
    if (current !== plaintext) {
      if (current !== content) {
        throw new Error('Account snapshot changed during migration; retry the operation');
      }
      // No await between comparison and replacement: same-owner writes cannot interleave.
      preserveAccountMigrationBackups(file, content, plaintext);
      writePrivateFileAtomically(file, plaintext);
    }
  }
  return backup;
}

/** Successful reads convert historical ciphertext to portable JSON using its original key. */
export async function readAccountBackupFile(file: string): Promise<AccountBackupData> {
  const content = await fs.promises.readFile(file, 'utf-8');
  return readSnapshot(file, content);
}

/** Account-list migration leaves plaintext snapshots untouched and reports a completed rewrite. */
export async function migrateAccountBackupFile(file: string): Promise<boolean> {
  const content = await fs.promises.readFile(file, 'utf8');
  if (!isEncryptedPayloadCandidate(content)) {
    return false;
  }
  await readSnapshot(file, content);
  return true;
}

export async function writeAccountBackupFile(
  file: string,
  backup: AccountBackupData,
): Promise<void> {
  const payload = JSON.stringify(backup);
  writePrivateFileAtomically(file, payload);
}
