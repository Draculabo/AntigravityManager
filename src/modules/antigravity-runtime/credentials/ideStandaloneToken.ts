import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CredentialStoreTokenInput } from '@/shared/auth/credentialStoreToken';
import { CredentialReadbackError } from '@/shared/auth/credentialReadbackError';
import { writePrivateFileAtomically } from '@/shared/persistence/privateFile';
import { buildAntigravityCredentialPayload } from './antigravityCredentialPayload';

export function getIdeStandaloneTokenPath(): string {
  return path.join(os.homedir(), '.gemini', 'jetski-standalone-oauth-token');
}

/** Reject unavailable destinations before closing the IDE; absence is a valid fresh install. */
export function validateIdeStandaloneDestination(): void {
  let current = getIdeStandaloneTokenPath();
  let checkedWritable = false;
  while (true) {
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        throw new Error('IDE standalone credential destination is not a regular file or directory');
      }
      if (!checkedWritable) {
        fs.accessSync(current, fs.constants.R_OK | fs.constants.W_OK);
        // Atomic replacement also requires write access to an existing file's directory.
        if (stat.isFile()) {
          fs.accessSync(path.dirname(current), fs.constants.W_OK);
        }
        checkedWritable = true;
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
}

export function writeIdeStandaloneToken(token: CredentialStoreTokenInput): void {
  writeIdeStandaloneCredentialPayload(buildAntigravityCredentialPayload(token));
}

/** Platform adapters supply the exact payload also installed in their native store. */
export function writeIdeStandaloneCredentialPayload(payload: string): void {
  const destination = getIdeStandaloneTokenPath();
  writePrivateFileAtomically(destination, payload);
  if (fs.readFileSync(destination, 'utf8') !== payload) {
    throw new CredentialReadbackError('IDE standalone credential write could not be confirmed', {});
  }
}
