import { app, BrowserWindow, Tray, Menu, nativeImage } from 'electron';
import path from 'path';
// import { installExtension, REACT_DEVELOPER_TOOLS } from 'electron-devtools-installer';
import { ipcMain } from 'electron/main';
import { ipcContext } from '@/ipc/context';
import { IPC_CHANNELS } from './constants';
// import { updateElectronApp, UpdateSourceType } from 'update-electron-app';
import { logger } from './utils/logger';

app.disableHardwareAcceleration();

const inDevelopment = process.env.NODE_ENV === 'development';

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let globalMainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

process.on('exit', (code) => {
  logger.info(`Process exit event triggered with code: ${code}`);
});

process.on('before-exit', (code) => {
  logger.info(`Process before-exit event triggered with code: ${code}`);
  logger.info(`Process before-exit event triggered with code: ${code}`);
});

function createTray() {
  const iconPath = inDevelopment
    ? path.join(process.cwd(), 'src/assets/tray.png')
    : path.join(process.resourcesPath, 'assets/tray.png'); // Prod path might need adjustment based on forge config

  logger.info(`createTray: loading icon from ${iconPath}`);
  const icon = nativeImage.createFromPath(iconPath);

  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show App',
      click: () => {
        if (globalMainWindow) {
          globalMainWindow.show();
          globalMainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip('Antigravity Manager');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (globalMainWindow) {
      if (globalMainWindow.isVisible()) {
        globalMainWindow.hide();
      } else {
        globalMainWindow.show();
        globalMainWindow.focus();
      }
    }
  });

  logger.info('createTray: Tray created successfully');
}

function createWindow() {
  logger.info('createWindow: start');
  const preload = path.join(__dirname, 'preload.js');
  logger.info(`createWindow: preload path: ${preload}`);

  logger.info('createWindow: attempting to create BrowserWindow');
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      devTools: inDevelopment,
      contextIsolation: true,
      nodeIntegration: true,
      nodeIntegrationInSubFrames: false,

      preload: preload,
    },
    // Use native frame with window controls
    // titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    // trafficLightPosition:
    //   process.platform === "darwin" ? { x: 5, y: 5 } : undefined,
  });
  globalMainWindow = mainWindow;
  logger.info('createWindow: BrowserWindow instance created');

  logger.info('createWindow: setting main window in ipcContext');
  ipcContext.setMainWindow(mainWindow);
  logger.info('createWindow: setMainWindow done');

  // TRIGGER ISOLATION: Load blank page
  logger.info('createWindow: LOADING ABOUT:BLANK for isolation test');
  mainWindow.loadURL('about:blank');

  /*
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    logger.info(`createWindow: loading URL ${MAIN_WINDOW_VITE_DEV_SERVER_URL}`);
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    logger.info('createWindow: loading file index.html');
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
  */

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

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    logger.info(`[Renderer Console] ${message} (${sourceId}:${line})`);
  });
}

app.on('child-process-gone', (event, details) => {
  logger.error('Child process gone:', details);
});

app.on('will-quit', (event) => {
  logger.info('App will quit event triggered');
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

function checkForUpdates() {
  updateElectronApp({
    updateSource: {
      type: UpdateSourceType.ElectronPublicUpdateService,
      repo: 'Draculabo/AntigravityManager',
    },
  });
}
*/

async function setupORPC() {
  const { rpcHandler } = await import('./ipc/handler');

  ipcMain.on(IPC_CHANNELS.START_ORPC_SERVER, (event) => {
    logger.info('IPC: Received START_ORPC_SERVER');
    const [serverPort] = event.ports;

    serverPort.start();
    logger.info('IPC: Server port started');
    try {
      rpcHandler.upgrade(serverPort);
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
    logger.info('Step: createWindow');
    await createWindow();
  })
  .then(() => {
    logger.info('Step: installExtensions (SKIPPED)');
    // return installExtensions();
  })
  .then(() => {
    logger.info('Step: checkForUpdates (SKIPPED)');
    // checkForUpdates();
  })
  .then(() => {
    logger.info('Step: setupORPC (SKIPPED)');
    // return setupORPC();
  })
  .then(async () => {
    // Initialize Cloud Monitor if enabled
    try {
      const { CloudAccountRepo } = require('./ipc/database/cloudHandler');

      // Initialize DB & Migrate to Encrypted Storage
      await CloudAccountRepo.init();

      const { CloudMonitorService } = require('./services/CloudMonitorService');
      const enabled = CloudAccountRepo.getSetting('auto_switch_enabled', false);
      if (enabled) {
        logger.info('Startup: Auto-Switch enabled, starting monitor...');
        CloudMonitorService.start();
      }
    } catch (e) {
      logger.error('Startup: Failed to initialize CloudMonitorService', e);
    }
  })
  .then(() => {
    logger.info('Step: Startup Complete');
    createTray();
  })
  .catch((error) => {
    logger.error('Failed to start application:', error);
    app.quit();
  });

//osX only
app.on('window-all-closed', () => {
  logger.info('Window all closed event triggered');
  // if (process.platform !== 'darwin') {
  //   app.quit();
  // }
  // Keep app running for tray
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
//osX only ends
