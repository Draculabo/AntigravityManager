import { ipcRenderer, contextBridge } from 'electron';
import * as Sentry from '@sentry/electron/renderer';
import { IPC_CHANNELS } from './constants';

import path from 'path';
import fs from 'fs';
import os from 'os';

// Config check logic (duplicate of instrument.ts logic but adapted for preload)
let sentryEnabled = false;
try {
  const home = os.homedir();
  let appDataPath = '';
  if (process.platform === 'win32') {
    appDataPath = path.join(
      process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
      'Antigravity',
    );
  } else if (process.platform === 'darwin') {
    appDataPath = path.join(home, 'Library', 'Application Support', 'Antigravity');
  } else {
    appDataPath = path.join(home, '.config', 'Antigravity');
  }

  const configPath = path.join(appDataPath, 'gui_config.json');
  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);
    sentryEnabled = config.error_reporting_enabled === true;
  }
} catch (e) {
  // console.error('Preload: Failed to read config', e);
}

if (sentryEnabled && process.env.NODE_ENV === 'production') {
  // Defer Sentry init to avoid blocking main thread during startup (white screen fix)
  setTimeout(() => {
    // console.log('[Preload] Initializing Sentry (Deferred)');
    Sentry.init({});
  }, 2000);
}
window.addEventListener('message', (event) => {
  if (event.data === IPC_CHANNELS.START_ORPC_SERVER) {
    const [serverPort] = event.ports;

    ipcRenderer.postMessage(IPC_CHANNELS.START_ORPC_SERVER, null, [serverPort]);
  }
});

contextBridge.exposeInMainWorld('electron', {
  SENTRY_ENABLED: sentryEnabled,
  onGoogleAuthCode: (callback: (code: string) => void) => {
    const handler = (_event: any, code: string) => callback(code);
    ipcRenderer.on('GOOGLE_AUTH_CODE', handler);
    return () => ipcRenderer.off('GOOGLE_AUTH_CODE', handler);
  },
  onCloudAccountSwitched: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('cloud://account-switched', handler);
    return () => ipcRenderer.off('cloud://account-switched', handler);
  },
  changeLanguage: (lang: string) => {
    ipcRenderer.send(IPC_CHANNELS.CHANGE_LANGUAGE, lang);
  },
});
