import path from 'path';

function getPathApi(platform: string) {
  if (platform === 'win32') {
    return path.win32;
  }

  return path;
}

function normalizeWindowsInstallDirName(appName: string) {
  return appName
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

export function getExpectedInstallRoot({
  platform,
  localAppData,
  appName,
}: {
  platform: string;
  localAppData?: string | null;
  appName: string;
}) {
  if (platform !== 'win32') {
    return null;
  }

  if (!localAppData) {
    return null;
  }

  const pathApi = getPathApi(platform);
  const installDirName = normalizeWindowsInstallDirName(appName);
  return pathApi.resolve(pathApi.join(localAppData, installDirName));
}

export function isRunningFromExpectedInstallDir({
  platform,
  isPackaged,
  localAppData,
  appName,
  execPath,
}: {
  platform: string;
  isPackaged: boolean;
  localAppData?: string | null;
  appName: string;
  execPath: string;
}) {
  if (platform !== 'win32' || !isPackaged) {
    return true;
  }

  const expectedRoot = getExpectedInstallRoot({ platform, localAppData, appName });
  if (!expectedRoot) {
    return true;
  }

  const pathApi = getPathApi(platform);
  const normalizedExecPath = pathApi.resolve(execPath);

  return normalizedExecPath.toLowerCase().startsWith(expectedRoot.toLowerCase() + pathApi.sep);
}
