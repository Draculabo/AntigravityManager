import './instrument'; // MUST be the first import to ensure Sentry initializes before app ready
import { configureDesktopCloudMonitorEffects } from '@/modules/cloud-account/ipc/cloud-monitor-desktop-effects';
import { isDesktopEmbeddedCloudAccountOwner } from '@/modules/cloud-account/ipc/cloud-account-adapter';
import { localAccountImportCoordinator } from '@/modules/cloud-account/local-import/local-account-import-coordinator.service';
import { localAccountPostImportService } from '@/modules/cloud-account/local-import/local-account-post-import.service';
import { app, BrowserWindow, dialog, shell } from 'electron';
import type { MessageBoxOptions } from 'electron';
import path from 'path';
import { getStandaloneRuntimePaths } from '@/shared/packaging/standalone-runtime-layout';
import fs from 'fs';
import squirrelStartup from 'electron-squirrel-startup';

import { ipcMain } from 'electron/main';
import { ipcContext } from '@/ipc/context';
import { desktopRpcAdmission } from '@/ipc/admission';
import { IPC_CHANNELS } from './shared/constants';
import { logger } from './shared/logging/logger';
import { shutdownDiagnosticStores } from '@/modules/proxy-gateway/diagnostics/shutdown';
import { ipcAuditRecorder } from '@/modules/proxy-gateway/audit/ipc-audit-recorder';
import { AppError } from '@/shared/errors/appError';
import {
  getExpectedInstallRoot,
  getInstallNoticeText,
  isRunningFromExpectedInstallDir as isRunningFromExpectedInstallDirUtil,
  resolveInstallNoticeLanguage,
} from './modules/app-shell/utils/installNotice';
import { applyStartupGpuSwitches } from '@/modules/app-shell/utils/startupGpuSwitches';
import { initializeDesktopAccountSecurity } from '@/modules/app-shell/services/account-security-startup';
import {
  bootstrapDesktopOwner,
  DesktopOwnerStartupError,
} from '@/modules/app-shell/services/desktop-owner-bootstrap';
import { desktopCoreConnection } from '@/modules/app-shell/services/desktop-core-connection';
import { selectDesktopOwners } from '@/modules/app-shell/services/desktop-owner-selection';
import { getDesktopStartupErrorTexts } from '@/modules/app-shell/services/desktop-startup-text';
import { getDesktopPreferencesLanguage } from '@/modules/config/ipc/desktop-preferences';
import { createDesktopShutdownCoordinator } from '@/modules/app-shell/services/desktop-shutdown';
import { ProfileLease, ProfileOwnershipError } from '@/core/ownership/profile-lease';
import { initDatabase } from '@/modules/account/public';
import { CloudMonitorService } from '@/modules/cloud-account/services/CloudMonitorService';
import { configureImageQuotaRefresh } from '@/modules/proxy-gateway/server/modules/openai/image-quota-refresh';
import { auditFileOwner } from '@/modules/proxy-gateway/audit/audit-file-owner.service';
import { auditOwner } from '@/modules/proxy-gateway/audit/audit-owner.service';
import { auditCurlOwner } from '@/modules/proxy-gateway/traffic-monitor/audit-curl-owner.service';
import { thoughtOwner } from '@/modules/proxy-gateway/thought-store/thought-owner.service';
import { openCodeOwner } from '@/modules/proxy-gateway/opencode-sync/opencode-owner.service';
import { agentToolsOwner } from '@/modules/proxy-gateway/agent-tools/agent-tools.owner';
import { localAccountOwner } from '@/modules/account/services/local-account-owner.service';
import { loadDesktopPreferences } from '@/modules/config/ipc/handlers';
import { serviceConfigService } from '@/modules/config/service-config.service';
import { cloudAccountAlertPolicy } from '@/modules/cloud-account/services/cloud-account-alert-policy.service';
import {
  getCloudAccountAdapter,
  startAccountOwnerPresentation,
  stopAccountOwnerPresentation,
  drainAccountOwnerPresentation,
} from '@/modules/cloud-account/ipc/cloud-account-adapter';
import { drainDesktopCloudAccountSwitches } from '@/modules/cloud-account/ipc/cloud-account-switch-desktop';
import { createWeeklyWarmupExecutor } from '@/modules/proxy-gateway/weekly-warmup-executor';
import { subscribeSelectedAuditEvents } from '@/modules/proxy-gateway/ipc/audit-presentation';
import { exportSelectedAuditBody } from '@/modules/proxy-gateway/ipc/audit-file-desktop';

// Static Imports to fix Bundle Resolution Errors
import { disableWindowsPowerThrottling } from '@/shared/platform/windowsPowerThrottling';
import { bootstrapNestServer, stopNestServer } from './server/main';
import {
  initTray,
  setTrayLanguage,
  destroyTray,
  setTrayMainWindow,
} from '@/modules/app-shell/ipc/tray/handler';
import { restoreExistingWindow } from '@/modules/app-shell/utils/windowActivation';
import { rpcHandler } from './ipc/handler';
import { ConfigManager } from '@/modules/config/ipc/manager';
import { AppConfig } from '@/modules/config/types';
import { isAutoStartLaunch, syncAutoStart } from '@/modules/antigravity-runtime/utils/autoStart';
import { safeStringifyPacket } from './shared/security/sensitiveDataMasking';
import {
  checkManualUpdate,
  getManualUpdateSnooze,
  isManualUpdateForceEnabled,
  isManualUpdateMockEnabled,
  snoozeManualUpdate,
} from '@/modules/app-shell/update/manualUpdateChecker';
import { isManualUpdateSnoozed } from '@/modules/app-shell/update/manualUpdatePolicy';
import type { ManualUpdateInfo } from '@/modules/app-shell/update/types';
import {
  checkElectronUpdaterUpdate,
  downloadElectronUpdaterUpdate,
  installElectronUpdaterUpdate,
  isElectronUpdaterDownloadReady,
  registerElectronUpdater,
} from '@/modules/app-shell/update/electronUpdaterService';
import { selectWindowsUpdateResult } from '@/modules/app-shell/update/windowsUpdateFallbackPolicy';
import { getQuickObservabilityConfig } from '@/shared/observability/observabilityConfig';
import { registerPerformanceRecorderIpc } from '@/modules/app-shell/performance-recorder/ipc';
import { configurePerformanceRecorderCommandLine } from '@/modules/app-shell/performance-recorder/main-recorder';
import { waitForViteDevServer } from '@/modules/app-shell/utils/wait-for-vite-dev-server';
import { isTrustedExternalUrl } from '@/modules/app-shell/utils/externalUrlPolicy';

// Turn on rotating file output as early as possible, before any module-level
// logging below runs, so the shipped app keeps logging to disk as before.
// Importing the logger module itself must stay free of filesystem side effects.
logger.enableFileLogging();
configureImageQuotaRefresh(() => getCloudAccountAdapter().forcePoll());

const packetLogPath = path.join(app.getPath('userData'), 'orpc_packets.log');

function logPacket(data: unknown) {
  if (process.env.DEBUG_ORPC_PACKETS !== 'true') {
    return;
  }

  try {
    fs.appendFile(
      packetLogPath,
      `[${new Date().toISOString()}] ${safeStringifyPacket(data)}\n`,
      (err) => {
        if (err) {
          logger.error('Failed to append ORPC packet log', err);
        }
      },
    );
  } catch (e) {
    if (e instanceof Error) {
      logger.error('Failed to append ORPC packet log', e);
    }
  }
}
ipcMain.on(IPC_CHANNELS.CHANGE_LANGUAGE, (event, lang) => {
  logger.info(`IPC: Received CHANGE_LANGUAGE: ${lang}`);
  setTrayLanguage(lang);
});

const gpuSwitchResult = applyStartupGpuSwitches(app, process.platform, process.env);
if (gpuSwitchResult.disabledHardwareAcceleration || gpuSwitchResult.appliedSwitches.length > 0) {
  logger.info(
    `Applied GPU-safe Chromium startup switches for ${process.platform}: ` +
      `hardwareAccelerationDisabled=${gpuSwitchResult.disabledHardwareAcceleration}, ` +
      `switches=[${gpuSwitchResult.appliedSwitches.join(', ')}]`,
  );
}

if (squirrelStartup) {
  app.quit();
  process.exit(0);
}

const inDevelopment = process.env.NODE_ENV === 'development';
const debugHttpProxy = process.env.http_proxy?.trim() || process.env.HTTP_PROXY?.trim();
const debugHttpsProxy = process.env.https_proxy?.trim() || process.env.HTTPS_PROXY?.trim();
const debugNoProxy = process.env.no_proxy?.trim() || process.env.NO_PROXY?.trim();
const debugProxyServer =
  process.env.ELECTRON_PROXY_SERVER?.trim() || debugHttpsProxy || debugHttpProxy;
const debugProxyBypassList =
  process.env.ELECTRON_PROXY_BYPASS_LIST?.trim() || '<local>;localhost;127.0.0.1;::1';

function configureDebugProxy() {
  if (debugHttpProxy || debugHttpsProxy) {
    logger.info(
      `[Debug Proxy] Axios will use HTTP(S) proxy environment settings (http: ${debugHttpProxy ?? 'none'}, https: ${debugHttpsProxy ?? 'none'}, no_proxy: ${debugNoProxy ?? 'none'})`,
    );
  }

  if (!debugProxyServer) {
    return;
  }

  // Route Chromium traffic through the local debug proxy while keeping local dev servers direct.
  app.commandLine.appendSwitch('proxy-server', debugProxyServer);
  app.commandLine.appendSwitch('proxy-bypass-list', debugProxyBypassList);
  logger.info(
    `[Debug Proxy] Electron proxy enabled: ${debugProxyServer} (bypass: ${debugProxyBypassList})`,
  );
}

configureDebugProxy();
configurePerformanceRecorderCommandLine();

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let globalMainWindow: BrowserWindow | null = null;
const auditPresentationStops = new Set<() => void>();
// let tray: Tray | null = null; // Moved to tray/handler.ts
let isQuitting = false;
let startupConfig: AppConfig | null = null;
const desktopProfileLease = new ProfileLease('desktop');
let desktopOwner: Awaited<ReturnType<typeof bootstrapDesktopOwner>> | undefined;
let ownerMode: 'desktop-embedded' | 'standalone-core' = 'desktop-embedded';
let shouldStartHidden = false;
let hasShownInstallNotice = false;
let pendingManualUpdate: ManualUpdateInfo | null = null;
let isManualUpdateRendererReady = false;
let updateInstallRequested = false;
const notifiedManualUpdateVersions = new Set<string>();

function isRunningFromExpectedInstallDir() {
  return isRunningFromExpectedInstallDirUtil({
    platform: process.platform,
    isPackaged: app.isPackaged,
    localAppData: process.env.LOCALAPPDATA,
    appName: app.getName(),
    execPath: process.execPath,
  });
}

function showWindowsInstallNoticeIfNeeded() {
  if (hasShownInstallNotice) {
    return;
  }

  if (isRunningFromExpectedInstallDir()) {
    return;
  }

  const expectedRoot = getExpectedInstallRoot({
    platform: process.platform,
    localAppData: process.env.LOCALAPPDATA,
    appName: app.getName(),
  });
  if (!expectedRoot) {
    return;
  }

  hasShownInstallNotice = true;
  const language = resolveInstallNoticeLanguage({
    configLanguage: startupConfig?.language,
    locale: app.getLocale(),
  });
  const text = getInstallNoticeText(language);

  const options: MessageBoxOptions = {
    type: 'info',
    title: text.title,
    message: text.message,
    detail: `${text.detailPrefix}${expectedRoot}`,
    buttons: [...text.buttons],
    defaultId: 1,
  };

  const showPromise = globalMainWindow
    ? dialog.showMessageBox(globalMainWindow, options)
    : dialog.showMessageBox(options);

  showPromise.then(({ response }) => {
    if (response === 0) {
      shell.openPath(expectedRoot);
    }
  });
}

function emitManualUpdateNotification(update: ManualUpdateInfo, { force = false } = {}) {
  if (!force && notifiedManualUpdateVersions.has(update.version)) {
    return;
  }

  if (
    !isManualUpdateRendererReady ||
    !globalMainWindow ||
    globalMainWindow.isDestroyed() ||
    !globalMainWindow.isVisible()
  ) {
    pendingManualUpdate = update;
    return;
  }

  globalMainWindow.webContents.send(IPC_CHANNELS.MANUAL_UPDATE_AVAILABLE, update);
  notifiedManualUpdateVersions.add(update.version);
}

function flushPendingManualUpdateNotification() {
  if (!pendingManualUpdate) {
    return;
  }

  if (
    !isManualUpdateRendererReady ||
    !globalMainWindow ||
    globalMainWindow.isDestroyed() ||
    !globalMainWindow.isVisible()
  ) {
    return;
  }

  const update = pendingManualUpdate;
  pendingManualUpdate = null;
  emitManualUpdateNotification(update);
}

async function checkWindowsUpdate(): Promise<Awaited<ReturnType<typeof checkManualUpdate>>> {
  const electronUpdaterResult = await checkElectronUpdaterUpdate();
  if (electronUpdaterResult.status === 'available') {
    return electronUpdaterResult;
  }

  const manualResult = await checkManualUpdate(app.getVersion());
  const result = selectWindowsUpdateResult({ electronUpdaterResult, manualResult });
  if (manualResult.status === 'available') {
    logger.warn(
      `Update: electron-updater reported ${electronUpdaterResult.status}, but GitHub release fallback found ${manualResult.update.version}`,
    );
  }

  return result;
}

ipcMain.handle(IPC_CHANNELS.CHECK_FOR_UPDATES, async () => {
  if (process.platform === 'win32') {
    const result = await checkWindowsUpdate();
    if (result.status === 'available') {
      emitManualUpdateNotification(result.update, { force: true });
    }

    return result;
  }

  const result = await checkManualUpdate(app.getVersion());
  if (result.status === 'available') {
    emitManualUpdateNotification(result.update, { force: true });
  }

  return result;
});

ipcMain.handle(IPC_CHANNELS.DOWNLOAD_UPDATE, async () => {
  return downloadElectronUpdaterUpdate();
});

ipcMain.handle(IPC_CHANNELS.INSTALL_UPDATE, async () => {
  if (!isElectronUpdaterDownloadReady()) {
    return { status: 'not-available' };
  }
  if (updateInstallRequested) {
    return { status: 'started' };
  }

  updateInstallRequested = true;
  isQuitting = true;
  desktopShutdown.request();
  return { status: 'started' };
});

ipcMain.on(IPC_CHANNELS.MANUAL_UPDATE_RENDERER_READY, () => {
  isManualUpdateRendererReady = true;
  flushPendingManualUpdateNotification();
});

ipcMain.handle(IPC_CHANNELS.DISMISS_MANUAL_UPDATE, async (_event, version: unknown) => {
  if (typeof version === 'string' && version.trim()) {
    snoozeManualUpdate(version);
  }
});

ipcMain.handle(IPC_CHANNELS.OPEN_EXTERNAL_URL, async (_event, url: unknown) => {
  if (typeof url !== 'string' || !isTrustedExternalUrl(url)) {
    logger.warn(`Blocked untrusted external URL request: ${String(url)}`);
    return;
  }

  await shell.openExternal(url);
});

ipcMain.handle(
  IPC_CHANNELS.SAVE_TRAFFIC_AUDIT_BODY,
  async (_event, bodyId: string, suggestedName: string) => {
    return exportSelectedAuditBody(bodyId, suggestedName, async (safeName) => {
      const options = {
        defaultPath: safeName,
        filters: [
          { name: 'JSON or text', extensions: ['json', 'txt', 'log'] },
          { name: 'All files', extensions: ['*'] },
        ],
        title: 'Save traffic audit body',
      };
      const result = globalMainWindow
        ? await dialog.showSaveDialog(globalMainWindow, options)
        : await dialog.showSaveDialog(options);
      return result.canceled ? null : (result.filePath ?? null);
    });
  },
);

ipcMain.handle(IPC_CHANNELS.GET_OBSERVABILITY_CONFIG, () => {
  return getQuickObservabilityConfig(
    (message, error) => {
      logger.error(message, error);
    },
    path.join(app.getPath('userData'), 'desktop-preferences.json'),
  );
});

registerPerformanceRecorderIpc();

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

if (isDev) {
  app.setName('Antigravity Manager Dev');
}

if (process.platform === 'win32') {
  app.setAppUserModelId(
    isDev ? 'com.draculabo.antigravity-manager.dev' : 'com.draculabo.antigravity-manager',
  );
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
} else {
  app.on('second-instance', () => {
    logger.info('Second instance detected, focusing existing window');
    if (app.isReady()) {
      createWindow({ startHidden: false });
      return;
    }
    app.whenReady().then(() => {
      createWindow({ startHidden: false });
    });
  });
}

process.on('exit', (code) => {
  logger.info(`Process exit event triggered with code: ${code}`);
});

process.on('before-exit', (code) => {
  logger.info(`Process before-exit event triggered with code: ${code}`);
  logger.info(`Process before-exit event triggered with code: ${code}`);
});

// let tray: Tray | null = null; // Moved to tray/handler.ts

function createWindow({ startHidden }: { startHidden: boolean }) {
  const existingWindow =
    globalMainWindow && !globalMainWindow.isDestroyed()
      ? globalMainWindow
      : (BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null);

  if (existingWindow) {
    globalMainWindow = existingWindow;
    setTrayMainWindow(existingWindow);
    if (startHidden) {
      existingWindow.hide();
      return;
    }
    if (process.platform === 'darwin' && typeof app.show === 'function') {
      app.show();
    }
    restoreExistingWindow(existingWindow);
    return;
  }

  logger.info('createWindow: start');
  const preload = path.join(__dirname, 'preload.js');
  const windowIcon =
    inDevelopment && process.platform === 'win32'
      ? path.join(process.cwd(), 'images/icon.ico')
      : inDevelopment
        ? path.join(process.cwd(), 'src/assets/icon.png')
        : path.join(__dirname, '../assets/icon.png');
  logger.info(`createWindow: preload path: ${preload}`);
  logger.info(`createWindow: window icon path: ${windowIcon}`);

  logger.info('createWindow: attempting to create BrowserWindow');
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: !startHidden,
    autoHideMenuBar: true,
    webPreferences: {
      backgroundThrottling: true,
      devTools: inDevelopment,
      sandbox: false,
      webviewTag: true,
      webSecurity: !inDevelopment,
      contextIsolation: false,
      nodeIntegration: true,
      nodeIntegrationInSubFrames: false,
      preload: preload,
    },
    icon: windowIcon,
  });
  globalMainWindow = mainWindow;
  setTrayMainWindow(mainWindow);
  logger.info('createWindow: BrowserWindow instance created');
  if (startHidden) {
    mainWindow.hide();
    logger.info('createWindow: startHidden enabled, window hidden');
  }

  logger.info('createWindow: setting main window in ipcContext');
  ipcContext.setMainWindow(mainWindow);
  const unsubscribeTrafficAudit = subscribeSelectedAuditEvents((event) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.TRAFFIC_AUDIT_EVENT, event);
    }
  });
  auditPresentationStops.add(unsubscribeTrafficAudit);
  logger.info('createWindow: setMainWindow done');

  if (inDevelopment && MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const devUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL;
    logger.info(`createWindow: waiting for Vite dev server at ${devUrl}`);

    waitForViteDevServer(devUrl).then((readyAfterMs) => {
      if (mainWindow.isDestroyed()) {
        logger.warn('createWindow: BrowserWindow destroyed before Vite URL load');
        return;
      }

      if (readyAfterMs !== null) {
        logger.info(`createWindow: Vite server ready after ${readyAfterMs}ms`);
        logger.info(`createWindow: loading URL ${devUrl}`);
        mainWindow.loadURL(devUrl);
      } else {
        logger.error('createWindow: Vite server did not start in time');
        logger.error('createWindow: Failed to connect to Vite server, loading anyway');
        mainWindow.loadURL(devUrl);
      }
    });
  } else {
    logger.info('createWindow: loading file index.html');
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  logger.info('Window created');
  showWindowsInstallNoticeIfNeeded();

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      if (mainWindow.isFullScreen()) {
        mainWindow.setFullScreen(false);
      }
      mainWindow.hide();
      logger.info('Window close intercepted -> Minimized to tray');
      return false;
    }
    logger.info('Window close event triggered (Quitting)');
  });

  mainWindow.on('closed', () => {
    unsubscribeTrafficAudit();
    auditPresentationStops.delete(unsubscribeTrafficAudit);
    logger.info('Window closed event triggered');
    globalMainWindow = null;
    setTrayMainWindow(null);
  });

  mainWindow.on('show', () => {
    flushPendingManualUpdateNotification();
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    logger.error('Renderer process gone:', details);
  });

  mainWindow.webContents.on('did-start-loading', () => {
    isManualUpdateRendererReady = false;
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    logger.error(`Page failed to load: ${errorCode} - ${errorDescription} - URL: ${validatedURL}`);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    logger.info('Page finished loading successfully');
  });

  mainWindow.webContents.on('console-message', (details) => {
    const { level, message, lineNumber, sourceId } = details;
    logger.info(`[Renderer Console][${level}] ${message} (${sourceId}:${lineNumber})`);
  });

  mainWindow.on('focus', () => {
    if (isDesktopEmbeddedCloudAccountOwner()) {
      CloudMonitorService.handleAppFocus();
    }
    flushPendingManualUpdateNotification();
  });
}

app.on('child-process-gone', (event, details) => {
  logger.error('Child process gone:', details);
});

let allowQuitAfterCleanup = false;
const desktopShutdown = createDesktopShutdownCoordinator({
  stopMonitor: () => {
    desktopRpcAdmission.close();
    for (const stop of auditPresentationStops) {
      stop();
    }
    auditPresentationStops.clear();
    stopAccountOwnerPresentation();
    if (ownerMode === 'standalone-core') {
      return;
    }
    CloudMonitorService.closeAdmission();
  },
  drainWarmups: async () => {
    await desktopRpcAdmission.drain();
    ipcAuditRecorder.closeAdmission();
    await ipcAuditRecorder.drain();
    await drainAccountOwnerPresentation();
    if (ownerMode === 'standalone-core') {
      return;
    }
    auditFileOwner.closeAdmission();
    auditOwner.closeAdmission();
    thoughtOwner.closeAdmission();
    auditCurlOwner.closeAdmission();
    openCodeOwner.closeAdmission();
    agentToolsOwner.closeAdmission();
    localAccountOwner.closeAdmission();
    cloudAccountAlertPolicy.closeAdmission();
    localAccountImportCoordinator.closeAdmission();
    await auditFileOwner.drain();
    await auditOwner.drain();
    await thoughtOwner.drain();
    await auditCurlOwner.drain();
    await openCodeOwner.drain();
    await agentToolsOwner.drain();
    serviceConfigService.closeAdmission();
    await localAccountOwner.drain();
    await serviceConfigService.drain();
    await localAccountImportCoordinator.drain();
    await localAccountPostImportService.drain();
    await CloudMonitorService.drain();
    await drainAccountOwnerPresentation();
  },
  drainAccountSwitches: () =>
    ownerMode === 'desktop-embedded' ? drainDesktopCloudAccountSwitches() : Promise.resolve(),
  stopAuth: async () => {
    if (ownerMode === 'standalone-core' && !desktopOwner) {
      return;
    }
    await getCloudAccountAdapter().stopLogin();
  },
  stopGateway: async () => {
    if (ownerMode === 'standalone-core') {
      await desktopOwner?.close();
      return;
    }
    const stopped = await stopNestServer();
    await shutdownDiagnosticStores();
    if (!stopped) {
      throw new Error('Gateway did not stop during desktop shutdown');
    }
    await desktopOwner?.close();
  },
  cleanupTimeoutMs: () => (ownerMode === 'standalone-core' ? 30_000 : 3000),
  destroyTray,
  exit: () => {
    allowQuitAfterCleanup = true;
    if (updateInstallRequested) {
      try {
        app.releaseSingleInstanceLock();
        const result = installElectronUpdaterUpdate();
        if (result.status === 'started') {
          return;
        }
        logger.warn(`WindowsUpdater: installation was not ready after shutdown: ${result.status}`);
      } catch {
        logger.warn('WindowsUpdater: installation failed to start after shutdown');
      }
    }
    app.quit();
  },
  warn: (message) => logger.warn(message),
});

function requestTrayShutdown(): Promise<void> {
  isQuitting = true;
  logger.info('Tray exit requested - stopping background services');
  return desktopShutdown.request();
}

app.on('before-quit', (event) => {
  isQuitting = true;
  if (allowQuitAfterCleanup) {
    return;
  }
  event.preventDefault();
  desktopShutdown.request();
  logger.info('App before-quit event triggered - isQuitting set to true');
});

app.on('will-quit', () => {
  logger.info('App will quit event triggered');
  try {
    destroyTray();
  } catch (err) {
    logger.error('Failed to destroy tray during will-quit', err);
  }
});

app.on('quit', (event, exitCode) => {
  logger.info(`App quit event triggered with code: ${exitCode}`);
});

/*
async function installExtensions() {
  try {
    const result = await installExtension(REACT_DEVELOPER_TOOLS);
    logger.info(`Extensions installed successfully: ${result.name}`);
  } catch {
    logger.error('Failed to install extensions');
  }
}
*/
async function checkForUpdates() {
  const isMockingManualUpdate = isManualUpdateMockEnabled();
  const isForcingManualUpdate = isManualUpdateForceEnabled();
  if (!app.isPackaged && !isMockingManualUpdate && !isForcingManualUpdate) {
    logger.info('Update: Skipping startup update check in development');
    return;
  }

  if (process.platform === 'win32' && !isMockingManualUpdate && !isForcingManualUpdate) {
    registerElectronUpdater(emitManualUpdateNotification);
    const result = await checkWindowsUpdate();
    if (result.status === 'available') {
      emitManualUpdateNotification(result.update);
    }
    return;
  }

  if (
    process.platform !== 'darwin' &&
    process.platform !== 'linux' &&
    !isMockingManualUpdate &&
    !isForcingManualUpdate
  ) {
    logger.info(`Update: No startup update check for platform ${process.platform}`);
    return;
  }

  const result = await checkManualUpdate(app.getVersion());
  if (result.status !== 'available') {
    if (result.status === 'error') {
      logger.warn(`Update: Manual startup check failed: ${result.message}`);
    }
    return;
  }

  const snooze = getManualUpdateSnooze();
  if (isManualUpdateSnoozed(snooze, result.update.version)) {
    logger.info(`Update: Manual update ${result.update.version} is snoozed`);
    return;
  }

  emitManualUpdateNotification(result.update);
}

async function setupORPC() {
  ipcMain.on(IPC_CHANNELS.START_ORPC_SERVER, (event) => {
    logger.info('IPC: Received START_ORPC_SERVER');
    const [port] = event.ports;

    if (process.env.DEBUG_ORPC_PACKETS === 'true') {
      port.on('message', (msgEvent) => {
        try {
          const data = msgEvent.data;
          logPacket(data);
        } catch {
          logger.debug('[RAW ORPC MSG] (unparseable)', msgEvent.data);
        }
      });
    }

    port.start();
    logger.info('IPC: Server port started');
    try {
      rpcHandler.upgrade(port);
      logger.info('IPC: rpcHandler upgraded successfully');
    } catch (error) {
      logger.error('IPC: Failed to upgrade rpcHandler', error);
    }
  });
}

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
});

app
  .whenReady()
  .then(async () => {
    if (process.platform === 'win32' && process.env.DISABLE_WINDOWS_POWER_THROTTLING === 'true') {
      disableWindowsPowerThrottling()
        .then(() => {
          logger.info('Disabled Windows Power Throttling / EcoQoS for the Electron main process');
        })
        .catch((error) => {
          logger.warn('Failed to disable Windows Power Throttling / EcoQoS', error);
        });
    }

    const preferences = await loadDesktopPreferences();
    ownerMode = preferences.owner_mode ?? 'desktop-embedded';
    syncAutoStart(preferences);
    shouldStartHidden =
      isAutoStartLaunch() && preferences.auto_startup && preferences.start_in_tray;
    const coreEntry = app.isPackaged
      ? getStandaloneRuntimePaths(process.resourcesPath).coreEntry
      : path.join(app.getAppPath(), 'dist', 'core', 'main.cjs');
    const nodeExecutable = app.isPackaged
      ? getStandaloneRuntimePaths(process.resourcesPath).nodeExecutable
      : 'node';
    desktopOwner = await bootstrapDesktopOwner({
      mode: ownerMode,
      lease: desktopProfileLease,
      ...desktopCoreConnection(coreEntry, nodeExecutable),
      selectDesktopEmbedded: () => selectDesktopOwners({ mode: 'desktop-embedded' }),
      initializeDesktopEmbedded: async () => {
        logger.info('Step: Load Config');
        const config = ConfigManager.loadConfig();
        startupConfig = config;
        if (shouldStartHidden) {
          logger.info('Startup: Auto-start detected, window will start hidden');
        }

        logger.info('Step: Initialize CloudAccountRepo');
        await initializeDesktopAccountSecurity();

        logger.info('Step: Initialize Antigravity DB (WAL Mode)');
        initDatabase();
      },
    });
  })
  .then(() => {
    logger.info('Step: setupORPC');
    return setupORPC();
  })
  .then(async () => {
    logger.info('Step: createWindow');
    await createWindow({ startHidden: shouldStartHidden });
  })
  .then(() => {
    logger.info('Step: installExtensions (SKIPPED)');
    // return installExtensions();
  })
  .then(() => {
    logger.info('Step: checkForUpdates');
    checkForUpdates();
  })
  .then(async () => {
    // Initialize Cloud Monitor if enabled
    try {
      if (!isDesktopEmbeddedCloudAccountOwner()) {
        return;
      }
      if (isDesktopEmbeddedCloudAccountOwner()) {
        configureDesktopCloudMonitorEffects();
        CloudMonitorService.openAdmission();
        CloudMonitorService.configureWeeklyWarmupExecutor(createWeeklyWarmupExecutor());
      }

      // Gateway Server (NestJS) - auto-start if enabled
      const config = startupConfig || ConfigManager.loadConfig();
      if (config.proxy?.auto_start) {
        const port = config.proxy?.port || 8045;
        let proxyStarted = false;
        // Default to a valid ProxyConfig object if null, although loadConfig ensures defaults
        if (config.proxy) {
          const result = await bootstrapNestServer(config.proxy);
          proxyStarted = result.success;
          if (result.success) {
            logger.info(`NestJS Proxy: Auto-started on port ${result.port}`);
          } else {
            logger.warn(`NestJS Proxy: Auto-start failed on port ${port}: ${result.message}`);
          }
        }
        if (!proxyStarted) {
          logger.info('NestJS Proxy: Auto-start skipped because the proxy server is not running');
        }
      }

      if (!isDesktopEmbeddedCloudAccountOwner()) {
        return;
      }
      if (CloudMonitorService.isContinuousPollingEnabled()) {
        logger.info('Startup: Background cloud monitoring enabled, starting monitor...');
        CloudMonitorService.start();
      } else {
        logger.info('Startup: Background monitoring disabled, running one-time cloud sync...');
        await CloudMonitorService.poll();
      }
    } catch (e) {
      logger.error('Startup: Failed to initialize services', e);
    }
  })
  .then(async () => {
    logger.info('Step: Startup Complete');
    if (globalMainWindow) {
      initTray(globalMainWindow, requestTrayShutdown);
    }
    await startAccountOwnerPresentation();
  })
  .catch(async (error) => {
    if (error instanceof DesktopOwnerStartupError) {
      logger.error('Selected core owner startup failed');
      const texts = await getDesktopStartupErrorTexts(
        getDesktopPreferencesLanguage(app.getLocale()),
        'core-unavailable',
      );
      dialog.showErrorBox(texts.title, texts.body);
      app.quit();
      return;
    }
    logger.error('Failed to start application:', error);
    if (error instanceof AppError && error.code === 'MASTER_KEY_UNAVAILABLE') {
      const texts = await getDesktopStartupErrorTexts(
        getDesktopPreferencesLanguage(app.getLocale()),
        'account-data-unavailable',
      );
      dialog.showErrorBox(texts.title, texts.body);
    }
    if (error instanceof ProfileOwnershipError) {
      const texts = await getDesktopStartupErrorTexts(
        getDesktopPreferencesLanguage(app.getLocale()),
        'already-running',
      );
      dialog.showErrorBox(texts.title, texts.body);
    }
    app.quit();
  });

//osX only
app.on('window-all-closed', () => {
  logger.info('Window all closed event triggered');
  if (isQuitting) {
    return;
  }
  if (process.platform !== 'darwin') {
    app.quit();
    return;
  }
  if (ownerMode === 'desktop-embedded') {
    stopNestServer();
  }
  // Keep app running for tray
});

app.on('activate', () => {
  logger.info('App activate event triggered');
  if (app.isReady()) {
    createWindow({ startHidden: false });
    return;
  }
  app.whenReady().then(() => {
    createWindow({ startHidden: false });
  });
});
//osX only ends
