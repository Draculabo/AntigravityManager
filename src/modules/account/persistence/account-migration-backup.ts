import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { hasErrorCode } from '@/shared/errors/error-guards';
import { writePrivateFileAtomically } from '@/shared/persistence/privateFile';

function ensurePrivateDirectory(directory: string): void {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) {
      throw error;
    }
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Account migration backup destination must be a regular directory');
  }
}

/** Existing history is verified, never replaced; interrupted temporary writes remain retryable. */
function preserveBackup(file: string, content: string): void {
  let exists = false;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== Buffer.byteLength(content)) {
      throw new Error('Account migration backup does not match its original version');
    }
    exists = true;
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }
  }
  if (!exists) {
    writePrivateFileAtomically(file, content);
  }
  if (fs.readFileSync(file, 'utf8') !== content) {
    throw new Error('Account migration backup could not be confirmed');
  }
}

/** Preserve both representations before migration; ciphertext identity retains separate history. */
export function preserveAccountMigrationBackups(
  snapshot: string,
  encrypted: string,
  plaintext: string,
): void {
  const root = `${snapshot}.migration-backups`;
  const version = path.join(root, createHash('sha256').update(encrypted, 'utf8').digest('hex'));
  ensurePrivateDirectory(root);
  ensurePrivateDirectory(version);
  preserveBackup(path.join(version, 'encrypted.snapshot'), encrypted);
  preserveBackup(path.join(version, 'decrypted.json'), plaintext);
}
