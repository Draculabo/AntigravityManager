import { app, BrowserWindow, Tray, Menu, nativeImage } from 'electron';
import path from 'path';
import fs from 'fs';

// import { installExtension, REACT_DEVELOPER_TOOLS } from 'electron-devtools-installer';
import { ipcMain } from 'electron/main';
import { ipcContext } from '@/ipc/context';
import { IPC_CHANNELS } from './constants';
import { updateElectronApp, UpdateSourceType } from 'update-electron-app';
import { logger } from './utils/logger';
import { CloudAccountRepo } from './ipc/database/cloudHandler';
import { CloudMonitorService } from './services/CloudMonitorService';

// Static Imports to fix Bundle Resolution Errors
import { AuthServer } from './ipc/cloud/authServer';
import { bootstrapNestServer, stopNestServer } from './server/main';
import { initTray, setTrayLanguage, destroyTray } from './ipc/tray/handler';
import { rpcHandler } from './ipc/handler';
import { ConfigManager } from './ipc/config/manager';

const packetLogPath = path.join(app.getPath('userData'), 'orpc_packets.log');

/**
 * Safely stringify an object, handling circular references
 */
function safeStringifyPacket(obj: unknown): string {
  const seen = new WeakSet();
  return JSON.stringify(obj, (key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]';
      }
      seen.add(value);
    }
    return value;
  });
}

function logPacket(data: any) {
  try {
    fs.appendFileSync(
      packetLogPath,
      `[${new Date().toISOString()}] ${safeStringifyPacket(data)}\n`,
    );
  } catch (e) {
    if (e instanceof Error) {
      console.error(e.message);
    }
  }
}
ipcMain.on(IPC_CHANNELS.CHANGE_LANGUAGE, (event, lang) => {
  logger.info(`IPC: Received CHANGE_LANGUAGE: ${lang}`);
  setTrayLanguage(lang);
});

app.disableHardwareAcceleration();

const inDevelopment = process.env.NODE_ENV === 'development';

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let globalMainWindow: BrowserWindow | null = null;
// let tray: Tray | null = null; // Moved to tray/handler.ts
let isQuitting = false;

process.on('exit', (code) => {
  logger.info(`Process exit event triggered with code: ${code}`);
});

process.on('before-exit', (code) => {
  logger.info(`Process before-exit event triggered with code: ${code}`);
  logger.info(`Process before-exit event triggered with code: ${code}`);
});

// let tray: Tray | null = null; // Moved to tray/handler.ts

function createWindow() {
  logger.info('createWindow: start');
  const preload = path.join(__dirname, 'preload.js');
  logger.info(`createWindow: preload path: ${preload}`);

  logger.info('createWindow: attempting to create BrowserWindow');
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    webPreferences: {
      devTools: inDevelopment,
      contextIsolation: true,
      nodeIntegration: true,
      nodeIntegrationInSubFrames: false,
      preload: preload,
    },
    // Use process.cwd() in dev to find the icon reliably
    icon: inDevelopment
      ? path.join(process.cwd(), 'src/assets/icon.png')
      : path.join(__dirname, '../assets/icon.png'),
  });
  globalMainWindow = mainWindow;
  logger.info('createWindow: BrowserWindow instance created');

  logger.info('createWindow: setting main window in ipcContext');
  ipcContext.setMainWindow(mainWindow);
  logger.info('createWindow: setMainWindow done');

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    logger.info(`createWindow: loading URL ${MAIN_WINDOW_VITE_DEV_SERVER_URL}`);
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    logger.info('createWindow: loading file index.html');
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  logger.info('Window created');

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
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    logger.error('Renderer process gone:', details);
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
}

app.on('child-process-gone', (event, details) => {
  logger.error('Child process gone:', details);
});

app.on('before-quit', () => {
  isQuitting = true;
  logger.info('App before-quit event triggered - isQuitting set to true');
});

app.on('will-quit', (event) => {
  logger.info('App will quit event triggered');
  destroyTray();
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
function checkForUpdates() {
  updateElectronApp({
    updateSource: {
      type: UpdateSourceType.ElectronPublicUpdateService,
      repo: 'Draculabo/AntigravityManager',
    },
  });
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
      } catch (e) {
        console.log('[RAW ORPC MSG] (unparseable)', msgEvent.data);
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
  .then(() => {
    logger.info('Step: setupORPC');
    return setupORPC();
  })
  .then(async () => {
    logger.info('Step: createWindow');
    await createWindow();
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
      // Initialize DB & Migrate to Encrypted Storage
      await CloudAccountRepo.init();

      // Start OAuth Server
      AuthServer.start();

      // Gateway Server (NestJS) - auto-start if enabled
      const config = ConfigManager.loadConfig();
      if (config.proxy?.auto_start) {
        const port = config.proxy?.port || 8045;
        // Default to a valid ProxyConfig object if null, although loadConfig ensures defaults
        if (config.proxy) {
          await bootstrapNestServer(config.proxy);
        }
        logger.info(`NestJS Proxy: Auto-started on port ${port}`);
      }

      const enabled = CloudAccountRepo.getSetting('auto_switch_enabled', false);
      if (enabled) {
        logger.info('Startup: Auto-Switch enabled, starting monitor...');
        CloudMonitorService.start();
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
    createWindow();
  }
});
//osX only ends
