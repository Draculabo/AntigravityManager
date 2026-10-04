import { existsSync } from 'node:fs';
import path from 'node:path';

const PACKAGE_ID = 'antigravity_manager';

export function getWindowsSquirrelVersion(execPath: string): string | null {
  const appDirectory = path.win32.dirname(execPath);
  const match = /^app-(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)$/i.exec(
    path.win32.basename(appDirectory),
  );
  return match?.[1] ?? null;
}

/** Squirrel launches the versioned app beside its root Update.exe and stub executable. */
export function isWindowsSquirrelInstall(
  execPath: string,
  updateExists: (file: string) => boolean = existsSync,
): boolean {
  const appDirectory = path.win32.dirname(execPath);
  if (!getWindowsSquirrelVersion(execPath)) {
    return false;
  }

  const installRoot = path.win32.dirname(appDirectory);
  if (path.win32.basename(installRoot).toLowerCase() !== PACKAGE_ID) {
    return false;
  }

  return updateExists(path.win32.join(installRoot, 'Update.exe'));
}
