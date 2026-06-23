import './instrument'; // MUST be the first import to ensure Sentry initializes before app ready
import { app, BrowserWindow, dialog, shell } from 'electron';
import type { MessageBoxOptions } from 'electron';
import path from 'path';
import fs from 'fs';
import squirrelStartup from 'electron-squirrel-startup';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

import { ipcMain } from 'electron/main';
import { ipcContext } from '@/ipc/context';
import { IPC_CHANNELS } from './shared/constants';
import { logger } from './shared/logging/logger';
import {
  getExpectedInstallRoot,
  getInstallNoticeText,
  isRunningFromExpectedInstallDir as isRunningFromExpectedInstallDirUtil,
  resolveInstallNoticeLanguage,
} from './modules/app-shell/utils/installNotice';
import { applyStartupGpuSwitches } from '@/modules/app-shell/utils/startupGpuSwitches';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { initDatabase } from '@/shared/persistence/database/handler';
import { CloudMonitorService } from '@/modules/cloud-account/services/CloudMonitorService';

// Static Imports to fix Bundle Resolution Errors
import { AuthServer } from '@/modules/cloud-account/ipc/authServer';
import { bootstrapNestServer, stopNestServer } from './server/main';
import { initTray, setTrayLanguage, destroyTray } from '@/modules/app-shell/ipc/tray/handler';
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
import { getWindowsUpdateBaseUrl } from '@/modules/app-shell/update/windowsUpdateSource';
import { getQuickObservabilityConfig } from '@/shared/observability/observabilityConfig';

const packetLogPath = path.join(app.getPath('userData'), 'orpc_packets.log');

function logPacket(data: any) {
  try {
    fs.appendFileSync(
      packetLogPath,
      `[${new Date().toISOString()}] ${safeStringifyPacket(data)}\n`,
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
    setGlobalDispatcher(
      new EnvHttpProxyAgent({
        httpProxy: debugHttpProxy,
        httpsProxy: debugHttpsProxy,
        noProxy: debugNoProxy,
      }),
    );
    logger.info(
      `[Debug Proxy] Node fetch proxy enabled (http: ${debugHttpProxy ?? 'none'}, https: ${debugHttpsProxy ?? 'none'}, no_proxy: ${debugNoProxy ?? 'none'})`,
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

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let globalMainWindow: BrowserWindow | null = null;
// let tray: Tray | null = null; // Moved to tray/handler.ts
let isQuitting = false;
let startupConfig: AppConfig | null = null;
let shouldStartHidden = false;
let hasShownInstallNotice = false;
let pendingManualUpdate: ManualUpdateInfo | null = null;
let isManualUpdateRendererReady = false;
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

function isTrustedReleaseUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    return (
      parsedUrl.protocol === 'https:' &&
      parsedUrl.hostname === 'github.com' &&
      parsedUrl.pathname.startsWith('/Draculabo/AntigravityManager/releases/')
    );
  } catch {
    return false;
  }
}

ipcMain.handle(IPC_CHANNELS.CHECK_FOR_UPDATES, async () => {
  const result = await checkManualUpdate(app.getVersion());
  if (result.status === 'available') {
    emitManualUpdateNotification(result.update, { force: true });
  }

  return result;
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
  if (typeof url !== 'string' || !isTrustedReleaseUrl(url)) {
    logger.warn(`Blocked untrusted external URL request: ${String(url)}`);
    return;
  }

  await shell.openExternal(url);
});

ipcMain.handle(IPC_CHANNELS.GET_OBSERVABILITY_CONFIG, () => {
  return getQuickObservabilityConfig((message, error) => {
    logger.error(message, error);
  });
});

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
  if (globalMainWindow && !globalMainWindow.isDestroyed()) {
    if (startHidden) {
      globalMainWindow.hide();
      return;
    }
    if (globalMainWindow.isMinimized()) {
      globalMainWindow.restore();
    }
    if (!globalMainWindow.isVisible()) {
      globalMainWindow.show();
    }
    globalMainWindow.focus();
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
  logger.info('createWindow: BrowserWindow instance created');
  if (startHidden) {
    mainWindow.hide();
    logger.info('createWindow: startHidden enabled, window hidden');
  }

  logger.info('createWindow: setting main window in ipcContext');
  ipcContext.setMainWindow(mainWindow);
  logger.info('createWindow: setMainWindow done');

  if (inDevelopment && MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const devUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL;
    logger.info(`createWindow: waiting for Vite dev server at ${devUrl}`);

    // Wait for Vite to be ready before loading
    const waitForVite = async (url: string, maxRetries = 30, delay = 500) => {
      for (let i = 0; i < maxRetries; i++) {
        try {
          const response = await fetch(url);
          if (response.ok) {
            logger.info(`createWindow: Vite server ready after ${i * delay}ms`);
            return true;
          }
        } catch {
          // Server not ready yet
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      logger.error('createWindow: Vite server did not start in time');
      return false;
    };

    waitForVite(devUrl).then((ready) => {
      if (mainWindow.isDestroyed()) {
        logger.warn('createWindow: BrowserWindow destroyed before Vite URL load');
        return;
      }

      if (ready) {
        logger.info(`createWindow: loading URL ${devUrl}`);
        mainWindow.loadURL(devUrl);
      } else {
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
      mainWindow.hide();
      logger.info('Window close intercepted -> Minimized to tray');
      return false;
    }
    logger.info('Window close event triggered (Quitting)');
  });

  mainWindow.on('closed', () => {
    logger.info('Window closed event triggered');
    globalMainWindow = null;
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
    CloudMonitorService.handleAppFocus();
    flushPendingManualUpdateNotification();
  });
}

app.on('child-process-gone', (event, details) => {
  logger.error('Child process gone:', details);
});

app.on('before-quit', () => {
  isQuitting = true;
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
    try {
      const { updateElectronApp, UpdateSourceType } = await import('update-electron-app');
      updateElectronApp({
        updateSource: {
          type: UpdateSourceType.StaticStorage,
          baseUrl: getWindowsUpdateBaseUrl(),
        },
      });
    } catch (error) {
      logger.error('Update: Failed to initialize Windows auto updater', error);
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

    // Debug: Inspect raw messages
    port.on('message', (msgEvent) => {
      try {
        const data = msgEvent.data;

        logPacket(data);
      } catch {
        logger.debug('[RAW ORPC MSG] (unparseable)', msgEvent.data);
      }
    });

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
    logger.info('Step: Load Config');
    const config = ConfigManager.loadConfig();
    startupConfig = config;
    syncAutoStart(config);
    shouldStartHidden = isAutoStartLaunch() && config.auto_startup && config.start_in_tray;
    if (shouldStartHidden) {
      logger.info('Startup: Auto-start detected, window will start hidden');
    }

    logger.info('Step: Initialize CloudAccountRepo');
    try {
      await CloudAccountRepo.init();
    } catch (e) {
      logger.error('Startup: Failed to initialize CloudAccountRepo', e);
    }

    logger.info('Step: Initialize Antigravity DB (WAL Mode)');
    initDatabase();
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
      // Start OAuth Server
      AuthServer.start();

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

      const enabled = CloudAccountRepo.getSetting('auto_switch_enabled', false);
      if (enabled) {
        logger.info('Startup: Auto-Switch enabled, starting monitor...');
        CloudMonitorService.start();
      } else {
        logger.info('Startup: Auto-Switch disabled, running one-time quota and AI credits sync...');
        await CloudMonitorService.poll();
      }
    } catch (e) {
      logger.error('Startup: Failed to initialize services', e);
    }
  })
  .then(async () => {
    logger.info('Step: Startup Complete');
    if (globalMainWindow) {
      initTray(globalMainWindow);
    }
  })
  .catch((error) => {
    logger.error('Failed to start application:', error);
    app.quit();
  });

//osX only
app.on('window-all-closed', () => {
  logger.info('Window all closed event triggered');
  stopNestServer(); // Stop server
  if (process.platform !== 'darwin') {
    app.quit();
  }
  // Keep app running for tray
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow({ startHidden: false });
  }
});
//osX only ends
