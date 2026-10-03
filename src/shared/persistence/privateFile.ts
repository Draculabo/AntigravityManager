import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Atomically replaces a private UTF-8 credential file in its owning directory. */
export function writePrivateFileAtomically(target: string, payload: string): void {
  fs.mkdirSync(path.dirname(target), { mode: 0o700, recursive: true });
  const tempPath = `${target}.${process.pid}-${randomUUID()}.agm-tmp`;

  try {
    fs.writeFileSync(tempPath, payload, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tempPath, target);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best-effort cleanup must not hide the original write failure.
    }
    throw error;
  }
}
