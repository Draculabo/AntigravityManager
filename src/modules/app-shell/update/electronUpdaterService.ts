import { app, autoUpdater } from 'electron';

import { logger } from '@/shared/logging/logger';
import { buildElectronUpdaterNotification } from './electronUpdaterPolicy';
import type { ManualUpdateCheckResult, ManualUpdateInfo } from './types';
import { getWindowsUpdateBaseUrl } from './windowsUpdateSource';
import {
  checkNsisUpdate,
  downloadNsisUpdate,
  installNsisUpdate,
  isNsisUpdateReady,
  registerNsisUpdater,
} from './windowsNsisUpdater';
import { detectWindowsUpdatePackage } from './windowsPackageFlavor';
import { findLatestSquirrelVersion, readSquirrelReleases } from './windowsSquirrelFeed';
import { getWindowsSquirrelVersion } from './windowsSquirrelInstall';

type NotifyUpdate = (update: ManualUpdateInfo, options?: { force?: boolean }) => void;

type UpdateActionResult =
  | { status: 'started' }
  | { status: 'unsupported' | 'not-available' | 'already-downloaded' | 'already-downloading' }
  | { status: 'error'; message: string };

const LOCAL_UPDATE_FEED_URL = process.env.AGM_UPDATE_FEED_URL?.trim();
const ALLOW_UNMANAGED_UPDATE_INSTALL = process.env.AGM_UPDATE_ALLOW_UNMANAGED === '1';
const UPDATE_CHECK_TIMEOUT_MS = 20_000;

let registered = false;
let notifyUpdate: NotifyUpdate | null = null;
let lastAvailableUpdate: ManualUpdateInfo | null = null;
let downloadedUpdate = false;
let isDownloading = false;

function getUpdateFeedUrl(): string {
  if (ALLOW_UNMANAGED_UPDATE_INSTALL && LOCAL_UPDATE_FEED_URL) {
    return LOCAL_UPDATE_FEED_URL;
  }
  return getWindowsUpdateBaseUrl({ platform: 'win32', arch: process.arch });
}

export function isElectronUpdaterSupported(platform = process.platform): boolean {
  return platform === 'win32';
}

function isElectronUpdaterEnabled(): boolean {
  return getWindowsUpdaterKind() !== null;
}

function getWindowsUpdaterKind(): 'squirrel' | 'nsis' | null {
  return detectWindowsUpdatePackage({
    platform: process.platform,
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    resourcesPath: process.resourcesPath,
    localAppData: process.env.LOCALAPPDATA,
    appName: app.getName(),
    allowUnmanagedSquirrel: ALLOW_UNMANAGED_UPDATE_INSTALL,
  });
}

function toNotification(version: string, state: 'available' | 'downloaded'): ManualUpdateInfo {
  return buildElectronUpdaterNotification({ state, platform: 'win32', version });
}

export function registerElectronUpdater(notify: NotifyUpdate): void {
  const kind = getWindowsUpdaterKind();
  if (kind === 'nsis') {
    registerNsisUpdater(notify);
    return;
  }
  if (kind !== 'squirrel') {
    logger.info('WindowsUpdater: current install is not a managed Windows package');
    return;
  }

  notifyUpdate = notify;
  if (registered) {
    return;
  }

  try {
    autoUpdater.setFeedURL({ url: getUpdateFeedUrl() });
  } catch {
    logger.warn('SquirrelUpdater: update feed configuration failed');
    return;
  }
  autoUpdater.on('update-available', () => {
    logger.info('SquirrelUpdater: update is available and downloading');
  });
  autoUpdater.on('update-not-available', () => {
    isDownloading = false;
    logger.info('SquirrelUpdater: no update in the feed');
  });
  autoUpdater.on('update-downloaded', () => {
    isDownloading = false;
    downloadedUpdate = true;
    logger.info('SquirrelUpdater: update downloaded');
    if (lastAvailableUpdate) {
      notifyUpdate?.(toNotification(lastAvailableUpdate.version, 'downloaded'), { force: true });
    }
  });
  autoUpdater.on('error', () => {
    isDownloading = false;
    logger.warn('SquirrelUpdater: update check or download failed');
    if (lastAvailableUpdate) {
      notifyUpdate?.({ ...lastAvailableUpdate, state: 'error' }, { force: true });
    }
  });
  registered = true;
}

export async function checkElectronUpdaterUpdate(): Promise<ManualUpdateCheckResult> {
  if (getWindowsUpdaterKind() === 'nsis') {
    return checkNsisUpdate();
  }
  if (!isElectronUpdaterEnabled()) {
    return { status: 'unsupported' };
  }

  try {
    const releases = await readSquirrelReleases(getUpdateFeedUrl());
    const version = findLatestSquirrelVersion(
      releases,
      getWindowsSquirrelVersion(process.execPath) ?? app.getVersion(),
      process.arch,
    );
    if (!version) {
      return { status: 'up-to-date' };
    }

    lastAvailableUpdate = toNotification(version, downloadedUpdate ? 'downloaded' : 'available');
    if (!downloadedUpdate) {
      lastAvailableUpdate = { ...lastAvailableUpdate, state: 'downloading' };
      void downloadElectronUpdaterUpdate();
    }
    return { status: 'available', update: lastAvailableUpdate };
  } catch {
    logger.warn('SquirrelUpdater: release index check failed');
    return { status: 'error', message: 'Update check failed' };
  }
}

export async function downloadElectronUpdaterUpdate(): Promise<UpdateActionResult> {
  if (getWindowsUpdaterKind() === 'nsis') {
    return downloadNsisUpdate();
  }
  if (!isElectronUpdaterEnabled()) {
    return { status: 'unsupported' };
  }
  if (downloadedUpdate) {
    return { status: 'already-downloaded' };
  }
  if (!lastAvailableUpdate) {
    return { status: 'not-available' };
  }
  if (isDownloading) {
    return { status: 'already-downloading' };
  }

  registerElectronUpdater(notifyUpdate ?? (() => {}));
  if (!registered) {
    return { status: 'error', message: 'Update download failed' };
  }
  isDownloading = true;
  notifyUpdate?.({ ...lastAvailableUpdate, state: 'downloading' }, { force: true });
  return new Promise<UpdateActionResult>((resolve) => {
    const finish = (result: UpdateActionResult) => {
      clearTimeout(timeout);
      autoUpdater.removeListener('update-available', onAvailable);
      autoUpdater.removeListener('update-not-available', onNotAvailable);
      autoUpdater.removeListener('error', onError);
      if (result.status !== 'started') {
        isDownloading = false;
      }
      resolve(result);
    };
    const onAvailable = () => finish({ status: 'started' });
    const onNotAvailable = () => finish({ status: 'not-available' });
    const onError = () => finish({ status: 'error', message: 'Update download failed' });
    const timeout = setTimeout(
      () => finish({ status: 'error', message: 'Update check timed out' }),
      UPDATE_CHECK_TIMEOUT_MS,
    );
    autoUpdater.once('update-available', onAvailable);
    autoUpdater.once('update-not-available', onNotAvailable);
    autoUpdater.once('error', onError);
    try {
      // Electron's Squirrel updater starts downloading as part of this check.
      autoUpdater.checkForUpdates();
    } catch {
      finish({ status: 'error', message: 'Update download failed' });
    }
  });
}

export function installElectronUpdaterUpdate(): UpdateActionResult {
  if (getWindowsUpdaterKind() === 'nsis') {
    if (!isNsisUpdateReady()) {
      return { status: 'not-available' };
    }

    installNsisUpdate();
    return { status: 'started' };
  }
  if (!isElectronUpdaterEnabled()) {
    return { status: 'unsupported' };
  }
  if (!downloadedUpdate) {
    return { status: 'not-available' };
  }

  autoUpdater.quitAndInstall();
  return { status: 'started' };
}

export function isElectronUpdaterDownloadReady(): boolean {
  if (getWindowsUpdaterKind() === 'nsis') {
    return isNsisUpdateReady();
  }
  return getWindowsUpdaterKind() === 'squirrel' && downloadedUpdate;
}
