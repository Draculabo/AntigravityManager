import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hasErrorCode } from '@/shared/errors/error-guards';

/** Publish complete profile bytes exclusively; an existing destination remains untouched. */
export function publishProfileFileIfMissing(filePath: string, createContent: () => string): void {
  if (fs.existsSync(filePath)) {
    return;
  }
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}-${randomUUID()}.tmp`);
  const failures: unknown[] = [];
  try {
    fs.writeFileSync(temporaryPath, createContent(), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try {
      fs.linkSync(temporaryPath, filePath);
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) {
        throw error;
      }
    }
  } catch (error) {
    failures.push(error);
  }
  try {
    fs.rmSync(temporaryPath, { force: true });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Profile publication and temporary-file cleanup failed');
  }
}
