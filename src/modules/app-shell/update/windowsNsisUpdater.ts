import { NsisUpdater } from 'electron-updater';
import type { ProgressInfo, UpdateInfo } from 'electron-updater';

import { logger } from '@/shared/logging/logger';
import { buildElectronUpdaterNotification } from './electronUpdaterPolicy';
import type { ManualUpdateCheckResult, ManualUpdateInfo } from './types';
import { getWindowsNsisUpdateBaseUrl } from './windowsUpdateSource';

type NotifyUpdate = (update: ManualUpdateInfo, options?: { force?: boolean }) => void;
type DownloadResult =
  | { status: 'started' | 'not-available' | 'already-downloaded' | 'already-downloading' }
  | { status: 'error'; message: string };

let updater: NsisUpdater | null = null;
let notifyUpdate: NotifyUpdate | null = null;
let availableVersion: string | null = null;
let downloadedVersion: string | null = null;
let downloadPromise: Promise<void> | null = null;
let reportedPercent = -1;

function notification(
  version: string,
  state: NonNullable<ManualUpdateInfo['state']>,
  downloadPercent?: number,
): ManualUpdateInfo {
  return buildElectronUpdaterNotification({
    platform: 'win32',
    version,
    state,
    downloadPercent,
  });
}

function broadcast(state: NonNullable<ManualUpdateInfo['state']>, percent?: number): void {
  if (availableVersion) {
    notifyUpdate?.(notification(availableVersion, state, percent), { force: true });
  }
}

function updateFeedUrl(): string {
  if (process.env.AGM_UPDATE_ALLOW_UNMANAGED === '1') {
    return process.env.AGM_UPDATE_FEED_URL?.trim() || getWindowsNsisUpdateBaseUrl();
  }
  return getWindowsNsisUpdateBaseUrl();
}

function getUpdater(): NsisUpdater {
  if (updater) {
    return updater;
  }

  const next = new NsisUpdater();
  next.autoDownload = false;
  next.autoInstallOnAppQuit = false;
  next.autoRunAppAfterInstall = true;
  next.allowPrerelease = false;
  next.disableWebInstaller = true;
  next.disableDifferentialDownload = true;
  next.setFeedURL({ provider: 'generic', url: updateFeedUrl() });
  next.logger = {
    info: (message?: unknown) => logger.info(`NsisUpdater: ${String(message ?? '')}`),
    warn: (message?: unknown) => logger.warn(`NsisUpdater: ${String(message ?? '')}`),
    error: (message?: unknown) => logger.error(`NsisUpdater: ${String(message ?? '')}`),
    debug: (message: string) => logger.debug(`NsisUpdater: ${message}`),
  };
  next.on('update-available', (info: UpdateInfo) => {
    availableVersion = info.version;
    if (downloadedVersion === info.version) {
      broadcast('downloaded', 100);
      return;
    }
    downloadedVersion = null;
    broadcast('downloading');
    void startNsisDownload();
  });
  next.on('download-progress', (progress: ProgressInfo) => {
    if (!Number.isFinite(progress.percent)) {
      return;
    }
    const percent = Math.max(0, Math.min(100, Math.floor(progress.percent)));
    if (percent >= reportedPercent + 5 || percent === 100) {
      reportedPercent = percent;
      broadcast('downloading', percent);
    }
  });
  next.on('update-downloaded', (info) => {
    downloadedVersion = info.version;
    availableVersion = info.version;
    broadcast('downloaded', 100);
  });
  next.on('error', () => {
    if (availableVersion && !downloadedVersion) {
      broadcast('error');
    }
  });

  updater = next;
  return next;
}

async function startNsisDownload(): Promise<void> {
  if (!availableVersion || downloadedVersion || downloadPromise) {
    return;
  }

  reportedPercent = -1;
  broadcast('downloading');
  downloadPromise = getUpdater()
    .downloadUpdate()
    .then(() => {
      if (!downloadedVersion) {
        logger.warn('NsisUpdater: download completed without a ready event');
        broadcast('error');
      }
    })
    .catch(() => {
      logger.warn('NsisUpdater: update download failed');
      broadcast('error');
    })
    .finally(() => {
      downloadPromise = null;
    });
  await downloadPromise;
}

export function registerNsisUpdater(notify: NotifyUpdate): void {
  notifyUpdate = notify;
  getUpdater();
}

export async function checkNsisUpdate(): Promise<ManualUpdateCheckResult> {
  try {
    const result = await getUpdater().checkForUpdates();
    if (!result?.isUpdateAvailable) {
      return { status: 'up-to-date' };
    }

    availableVersion = result.updateInfo.version;
    const state = downloadedVersion === availableVersion ? 'downloaded' : 'downloading';
    return { status: 'available', update: notification(availableVersion, state) };
  } catch {
    logger.warn('NsisUpdater: update check failed');
    return { status: 'error', message: 'Update check failed' };
  }
}

export function downloadNsisUpdate(): DownloadResult {
  if (downloadedVersion) {
    return { status: 'already-downloaded' };
  }
  if (!availableVersion) {
    return { status: 'not-available' };
  }
  if (downloadPromise) {
    return { status: 'already-downloading' };
  }

  void startNsisDownload();
  return { status: 'started' };
}

export function isNsisUpdateReady(): boolean {
  return downloadedVersion !== null;
}

export function installNsisUpdate(): void {
  getUpdater().quitAndInstall(true, true);
}
