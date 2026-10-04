import { existsSync } from 'node:fs';

import { isRunningFromExpectedInstallDir } from '@/modules/app-shell/utils/installNotice';
import { isWindowsNsisInstall } from './windowsNsisInstall';
import { isWindowsSquirrelInstall } from './windowsSquirrelInstall';

export type WindowsUpdatePackage = 'squirrel' | 'nsis' | null;

export function detectWindowsUpdatePackage({
  platform,
  isPackaged,
  execPath,
  resourcesPath,
  localAppData,
  appName,
  allowUnmanagedSquirrel = false,
  fileExists = existsSync,
}: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  execPath: string;
  resourcesPath: string;
  localAppData?: string;
  appName: string;
  allowUnmanagedSquirrel?: boolean;
  fileExists?: (file: string) => boolean;
}): WindowsUpdatePackage {
  if (platform !== 'win32' || !isPackaged) {
    return null;
  }

  if (isWindowsSquirrelInstall(execPath, fileExists)) {
    if (
      allowUnmanagedSquirrel ||
      isRunningFromExpectedInstallDir({
        platform,
        isPackaged,
        execPath,
        localAppData,
        appName,
      })
    ) {
      return 'squirrel';
    }
    return null;
  }

  if (isWindowsNsisInstall(execPath, resourcesPath, fileExists)) {
    return 'nsis';
  }

  return null;
}
