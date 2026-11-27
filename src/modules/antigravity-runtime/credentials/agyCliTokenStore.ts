import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writePrivateFileAtomically } from '@/shared/persistence/privateFile';

/** Writes only the Agy CLI session owned by the current operating-system environment. */
export function writeAgyCliToken(
  payload: string,
  writeFile: (file: string, payload: string) => void = writePrivateFileAtomically,
): void {
  const target = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  writeFile(target, payload);
  if (fs.readFileSync(target, 'utf-8') !== payload) {
    throw new Error('Client CLI session write could not be confirmed');
  }
}
