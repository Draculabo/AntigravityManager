import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

export interface WriteJsonFileAtomicOptions {
  /** Indentation passed to `JSON.stringify`. Omit for the compact form. */
  space?: number;
}

/**
 * Reads JSON written by an earlier run.
 *
 * A missing, truncated or otherwise unparsable file is reported as `null`
 * rather than thrown: everything persisted through this helper is recoverable
 * state, and a damaged file must never stop the app from starting.
 */
export function readJsonFileSync(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
  } catch {
    return null;
  }
}

/**
 * Writes JSON so that a process killed mid-write leaves either the previous
 * content or the new content and never a half-written file: the payload lands
 * in a sibling temp file which is then renamed over the target.
 */
export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
  options: WriteJsonFileAtomicOptions = {},
): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.promises.mkdir(directory, { recursive: true });

  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(temporaryPath, JSON.stringify(value, null, options.space), 'utf-8');
    await fs.promises.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
