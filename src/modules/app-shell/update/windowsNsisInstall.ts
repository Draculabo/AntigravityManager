import { existsSync } from 'node:fs';
import path from 'node:path';

/** The NSIS uninstaller distinguishes an installed app from an unpacked Forge package. */
export function isWindowsNsisInstall(
  execPath: string,
  resourcesPath: string,
  fileExists: (file: string) => boolean = existsSync,
): boolean {
  const installRoot = path.win32.dirname(execPath);
  const expectedResources = path.win32.join(installRoot, 'resources');
  if (path.win32.resolve(resourcesPath).toLowerCase() !== expectedResources.toLowerCase()) {
    return false;
  }

  return (
    fileExists(path.win32.join(resourcesPath, 'app-update.yml')) &&
    fileExists(path.win32.join(installRoot, 'Uninstall antigravity-manager.exe'))
  );
}
