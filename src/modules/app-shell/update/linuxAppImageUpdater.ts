import { AppImageUpdater } from 'electron-updater';
import type { ProgressInfo, UpdateInfo } from 'electron-updater';
import { logger } from '@/shared/logging/logger';
import { buildElectronUpdaterNotification } from './electronUpdaterPolicy';
import { getAppImageInstallTarget, isCompatibleAppImage } from './linuxAppImageInstall';
import type { ManualUpdateCheckResult, ManualUpdateInfo, UpdateNotificationState } from './types';

type NotifyUpdate = (update: ManualUpdateInfo, options?: { force?: boolean }) => void;
type ActionResult =
  | {
      status:
        | 'started'
        | 'unsupported'
        | 'not-available'
        | 'already-downloaded'
        | 'already-downloading';
    }
  | { status: 'error'; message: string };

const RELEASE_DOWNLOAD_URL =
  'https://github.com/Draculabo/AntigravityManager/releases/latest/download';
let updater: AppImageUpdater | null = null;
let installTarget: string | null = null;
let notifyUpdate: NotifyUpdate | null = null;
let availableVersion: string | null = null;
let downloadedVersion: string | null = null;
let downloadedFile: string | null = null;
let state: UpdateNotificationState = 'available';
let percent: number | undefined;
let checkPromise: Promise<ManualUpdateCheckResult> | null = null;
let downloadPromise: Promise<void> | null = null;
let installFailed = false;

function notification(version: string): ManualUpdateInfo {
  return buildElectronUpdaterNotification({
    platform: 'linux',
    version,
    state,
    downloadPercent: percent,
  });
}

function broadcast(nextState: UpdateNotificationState, nextPercent?: number): void {
  state = nextState;
  percent = nextPercent;
  if (availableVersion) {
    notifyUpdate?.(notification(availableVersion), { force: true });
  }
}

export function isAppImageUpdaterEnabled(): boolean {
  const target = getAppImageInstallTarget();
  return target !== null && (installTarget === null || target === installTarget);
}

function getUpdater(): AppImageUpdater {
  if (updater) {
    return updater;
  }
  installTarget = getAppImageInstallTarget();
  const next = new AppImageUpdater();
  next.autoDownload = false;
  next.autoInstallOnAppQuit = false;
  next.autoRunAppAfterInstall = true;
  next.allowPrerelease = false;
  // Forge's AppImage maker does not guarantee the embedded differential block map.
  next.disableDifferentialDownload = true;
  next.setFeedURL({
    provider: 'generic',
    url:
      process.env.AGM_UPDATE_ALLOW_UNMANAGED === '1'
        ? process.env.AGM_UPDATE_FEED_URL?.trim() || RELEASE_DOWNLOAD_URL
        : RELEASE_DOWNLOAD_URL,
  });
  next.logger = {
    info: () => undefined,
    warn: () => logger.warn('AppImageUpdater: update library warning'),
    error: () => logger.warn('AppImageUpdater: update library error'),
    debug: () => undefined,
  };
  next.on('update-available', (info: UpdateInfo) => {
    availableVersion = info.version;
    if (downloadedVersion === info.version) {
      broadcast('downloaded', 100);
      return;
    }
    downloadedVersion = null;
    downloadedFile = null;
    startDownload();
  });
  next.on('download-progress', (progress: ProgressInfo) => {
    if (state !== 'downloading' || !Number.isFinite(progress.percent)) {
      return;
    }
    const value = Math.max(0, Math.min(100, Math.floor(progress.percent)));
    if (percent === undefined || value >= percent + 5 || value === 100) {
      broadcast('downloading', value);
    }
  });
  next.on('update-downloaded', (info) => {
    if (info.version === availableVersion) {
      if (!isCompatibleAppImage(info.downloadedFile)) {
        logger.warn('AppImageUpdater: downloaded archive is incompatible');
        broadcast('error');
        return;
      }
      downloadedVersion = info.version;
      downloadedFile = info.downloadedFile;
      broadcast('downloaded', 100);
    }
  });
  next.on('error', () => {
    installFailed = true;
    logger.warn('AppImageUpdater: update operation failed');
    if (availableVersion) {
      broadcast('error');
    }
  });
  updater = next;
  return next;
}

async function startDownload(): Promise<void> {
  if (!availableVersion || downloadedVersion || downloadPromise) {
    return;
  }
  if (!isAppImageUpdaterEnabled()) {
    broadcast('error');
    return;
  }
  broadcast('downloading');
  // Defer the library call until the promise is assigned, including synchronous event delivery.
  downloadPromise = Promise.resolve()
    .then(() => getUpdater().downloadUpdate())
    .then(() => {
      if (!downloadedVersion) {
        broadcast('error');
      }
    })
    .catch(() => {
      logger.warn('AppImageUpdater: verified download failed');
      broadcast('error');
    })
    .finally(() => {
      downloadPromise = null;
    });
  await downloadPromise;
}

export function registerAppImageUpdater(notify: NotifyUpdate): void {
  notifyUpdate = notify;
  if (isAppImageUpdaterEnabled()) {
    getUpdater();
  }
}

export function checkAppImageUpdate(): Promise<ManualUpdateCheckResult> {
  if (!isAppImageUpdaterEnabled()) {
    return Promise.resolve({ status: 'unsupported' });
  }
  if (checkPromise) {
    return checkPromise;
  }
  if (downloadPromise && availableVersion) {
    return Promise.resolve({ status: 'available', update: notification(availableVersion) });
  }
  checkPromise = Promise.resolve()
    .then(async (): Promise<ManualUpdateCheckResult> => {
      const result = await getUpdater().checkForUpdates();
      if (!result?.isUpdateAvailable) {
        return { status: 'up-to-date' };
      }
      return { status: 'available', update: notification(result.updateInfo.version) };
    })
    .catch((): ManualUpdateCheckResult => {
      logger.warn('AppImageUpdater: release check failed');
      return { status: 'error', message: 'Update check failed' };
    })
    .finally(() => {
      checkPromise = null;
    });
  return checkPromise;
}

export function downloadAppImageUpdate(): ActionResult {
  if (!isAppImageUpdaterEnabled()) {
    return { status: 'unsupported' };
  }
  if (downloadedVersion) {
    return { status: 'already-downloaded' };
  }
  if (!availableVersion) {
    return { status: 'not-available' };
  }
  if (downloadPromise) {
    return { status: 'already-downloading' };
  }
  startDownload();
  return { status: 'started' };
}

export function isAppImageUpdateReady(): boolean {
  if (
    downloadedVersion &&
    (!isAppImageUpdaterEnabled() || !downloadedFile || !isCompatibleAppImage(downloadedFile))
  ) {
    downloadedVersion = null;
    downloadedFile = null;
    broadcast('error');
    return false;
  }
  return downloadedVersion !== null;
}

export function installAppImageUpdate(): ActionResult {
  if (!isAppImageUpdateReady()) {
    return { status: 'not-available' };
  }
  installFailed = false;
  try {
    getUpdater().quitAndInstall(true, true);
    return installFailed
      ? { status: 'error', message: 'Update installation failed' }
      : { status: 'started' };
  } catch {
    logger.warn('AppImageUpdater: installation failed');
    broadcast('error');
    return { status: 'error', message: 'Update installation failed' };
  }
}
