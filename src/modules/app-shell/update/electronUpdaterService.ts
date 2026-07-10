import { app } from 'electron';
import type {
  AppUpdater,
  ProgressInfo,
  UpdateCheckResult,
  UpdateDownloadedEvent,
  UpdateInfo,
} from 'electron-updater';
import { NsisUpdater } from 'electron-updater';
import { DownloadedUpdateHelper } from 'electron-updater/out/DownloadedUpdateHelper';

import { isRunningFromExpectedInstallDir } from '@/modules/app-shell/utils/installNotice';
import { logger } from '@/shared/logging/logger';
import { buildElectronUpdaterNotification } from './electronUpdaterPolicy';
import type { ManualUpdateCheckResult, ManualUpdateInfo } from './types';

type NotifyUpdate = (update: ManualUpdateInfo, options?: { force?: boolean }) => void;

type UpdateActionResult =
  | {
      status: 'started';
    }
  | {
      status: 'unsupported' | 'not-available' | 'already-downloaded' | 'already-downloading';
    }
  | {
      status: 'error';
      message: string;
    };

const GITHUB_UPDATE_FEED = {
  provider: 'github' as const,
  owner: 'Draculabo',
  repo: 'AntigravityManager',
};
const LOCAL_UPDATE_FEED_URL = process.env.AGM_UPDATE_FEED_URL?.trim();
const ALLOW_UNMANAGED_UPDATE_INSTALL = process.env.AGM_UPDATE_ALLOW_UNMANAGED === '1';

function getUpdateFeed() {
  if (LOCAL_UPDATE_FEED_URL) {
    return {
      provider: 'generic' as const,
      url: LOCAL_UPDATE_FEED_URL,
    };
  }

  return GITHUB_UPDATE_FEED;
}

class WindowsForgeUpdater extends NsisUpdater {
  protected override downloadedUpdateHelper = new DownloadedUpdateHelper(
    app.getPath('sessionData'),
  );

  constructor() {
    super();

    // Current Windows artifacts are not signed. Keep this local and explicit until release signing
    // is available, otherwise electron-updater rejects the downloaded installer before UI can act.
    this.verifyUpdateCodeSignature = async () => null;
  }
}

let updater: AppUpdater | null = null;
let registered = false;
let notifyUpdate: NotifyUpdate | null = null;
let lastAvailableUpdate: UpdateInfo | null = null;
let downloadedUpdate: UpdateDownloadedEvent | null = null;
let isDownloading = false;

export function isElectronUpdaterSupported(platform = process.platform): boolean {
  return platform === 'win32';
}

function isElectronUpdaterEnabled(): boolean {
  if (!isElectronUpdaterSupported() || !app.isPackaged) {
    return false;
  }

  if (ALLOW_UNMANAGED_UPDATE_INSTALL) {
    return true;
  }

  return isRunningFromExpectedInstallDir({
    platform: process.platform,
    isPackaged: app.isPackaged,
    localAppData: process.env.LOCALAPPDATA,
    appName: app.getName(),
    execPath: process.execPath,
  });
}

function getUpdater(): AppUpdater {
  if (!updater) {
    updater = new WindowsForgeUpdater();
  }

  return updater;
}

function logUpdaterError(message: string, error: unknown): void {
  logger.error(message, error instanceof Error ? error : new Error(String(error)));
}

function toUpdateNotification(
  state: ManualUpdateInfo['state'],
  updateInfo: Pick<UpdateInfo, 'version' | 'releaseName'>,
): ManualUpdateInfo {
  return buildElectronUpdaterNotification({
    state: state ?? 'available',
    platform: 'win32',
    version: updateInfo.version,
    releaseName: typeof updateInfo.releaseName === 'string' ? updateInfo.releaseName : null,
  });
}

export function registerElectronUpdater(notify: NotifyUpdate): void {
  if (!isElectronUpdaterEnabled()) {
    logger.info(
      `ElectronUpdater: current ${process.platform} install is not managed by electron-updater`,
    );
    return;
  }

  notifyUpdate = notify;

  if (registered) {
    return;
  }

  const appUpdater = getUpdater();
  appUpdater.autoDownload = false;
  appUpdater.autoInstallOnAppQuit = false;
  appUpdater.autoRunAppAfterInstall = true;
  appUpdater.allowPrerelease = false;
  appUpdater.disableDifferentialDownload = true;
  appUpdater.forceDevUpdateConfig = !app.isPackaged;
  appUpdater.logger = {
    info: (message?: unknown) => logger.info(`ElectronUpdater: ${String(message ?? '')}`),
    warn: (message?: unknown) => logger.warn(`ElectronUpdater: ${String(message ?? '')}`),
    error: (message?: unknown) => logger.error(`ElectronUpdater: ${String(message ?? '')}`),
    debug: (message: string) => logger.debug(`ElectronUpdater: ${message}`),
  };
  appUpdater.setFeedURL(getUpdateFeed());

  if (LOCAL_UPDATE_FEED_URL) {
    logger.warn(`ElectronUpdater: using local update feed ${LOCAL_UPDATE_FEED_URL}`);
  }

  if (ALLOW_UNMANAGED_UPDATE_INSTALL) {
    logger.warn('ElectronUpdater: unmanaged install checks are disabled for local verification');
  }

  appUpdater.on('checking-for-update', () => {
    logger.info('ElectronUpdater: checking for update');
  });

  appUpdater.on('update-available', (updateInfo) => {
    logger.info(`ElectronUpdater: update available ${updateInfo.version}`);
    lastAvailableUpdate = updateInfo;
    downloadedUpdate = null;
    notifyUpdate?.(toUpdateNotification('available', updateInfo), { force: true });
  });

  appUpdater.on('update-not-available', (updateInfo) => {
    logger.info(`ElectronUpdater: update not available ${updateInfo.version}`);
  });

  appUpdater.on('download-progress', (progress: ProgressInfo) => {
    logger.info(`ElectronUpdater: download progress ${progress.percent.toFixed(2)}%`);
  });

  appUpdater.on('update-downloaded', (event) => {
    isDownloading = false;
    downloadedUpdate = event;
    logger.info(`ElectronUpdater: update downloaded ${event.version}`);
    notifyUpdate?.(toUpdateNotification('downloaded', event), { force: true });
  });

  appUpdater.on('error', (error) => {
    isDownloading = false;
    logUpdaterError('ElectronUpdater: updater error', error);
  });

  registered = true;
}

export async function checkElectronUpdaterUpdate(): Promise<ManualUpdateCheckResult> {
  if (!isElectronUpdaterEnabled()) {
    return { status: 'unsupported' };
  }

  try {
    const result: UpdateCheckResult | null = await getUpdater().checkForUpdates();
    if (!result?.isUpdateAvailable) {
      return { status: 'up-to-date' };
    }

    lastAvailableUpdate = result.updateInfo;
    return {
      status: 'available',
      update: toUpdateNotification('available', result.updateInfo),
    };
  } catch (error) {
    logUpdaterError('ElectronUpdater: failed to check for updates', error);
    return {
      status: 'error',
      message: error instanceof Error ? error.message : 'Unknown update check error',
    };
  }
}

export async function downloadElectronUpdaterUpdate(): Promise<UpdateActionResult> {
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

  isDownloading = true;
  try {
    await getUpdater().downloadUpdate();

    return { status: 'already-downloaded' };
  } catch (error) {
    isDownloading = false;
    logUpdaterError('ElectronUpdater: failed to download update', error);

    return {
      status: 'error',
      message: error instanceof Error ? error.message : 'Unknown update download error',
    };
  }
}

export function installElectronUpdaterUpdate(): UpdateActionResult {
  if (!isElectronUpdaterEnabled()) {
    return { status: 'unsupported' };
  }

  if (!downloadedUpdate) {
    return { status: 'not-available' };
  }

  getUpdater().quitAndInstall(false, true);
  return { status: 'started' };
}
