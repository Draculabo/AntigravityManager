import { ipcRenderer, contextBridge } from 'electron';
import { IPC_CHANNELS } from './shared/constants';

window.addEventListener('message', (event) => {
  if (event.data === IPC_CHANNELS.START_ORPC_SERVER) {
    const [serverPort] = event.ports;

    ipcRenderer.postMessage(IPC_CHANNELS.START_ORPC_SERVER, null, [serverPort]);
  }
});

const electronBridge = {
  getObservabilityConfig: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_OBSERVABILITY_CONFIG);
  },
  onGoogleAuthCode: (callback: (code: string) => void) => {
    const handler = (_event: any, code: string) => callback(code);
    ipcRenderer.on('GOOGLE_AUTH_CODE', handler);
    return () => ipcRenderer.off('GOOGLE_AUTH_CODE', handler);
  },
  changeLanguage: (lang: string) => {
    ipcRenderer.send(IPC_CHANNELS.CHANGE_LANGUAGE, lang);
  },
  onManualUpdateAvailable: (callback: (update: ManualUpdateInfo) => void) => {
    const handler = (_event: any, update: ManualUpdateInfo) => callback(update);
    ipcRenderer.on(IPC_CHANNELS.MANUAL_UPDATE_AVAILABLE, handler);
    ipcRenderer.send(IPC_CHANNELS.MANUAL_UPDATE_RENDERER_READY);
    return () => ipcRenderer.off(IPC_CHANNELS.MANUAL_UPDATE_AVAILABLE, handler);
  },
  checkForUpdates: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.CHECK_FOR_UPDATES);
  },
  dismissManualUpdate: (version: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.DISMISS_MANUAL_UPDATE, version);
  },
  openExternalUrl: (url: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.OPEN_EXTERNAL_URL, url);
  },
};

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('electron', electronBridge);
} else {
  window.electron = electronBridge;
}
