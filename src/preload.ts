import { ipcRenderer, contextBridge, type IpcRendererEvent } from 'electron';
import type { RendererPerformanceSnapshot } from './modules/app-shell/performance-recorder/types';
import {
  TrafficAuditEventSchema,
  type TrafficAuditEvent,
} from './modules/proxy-gateway/audit/traffic-audit.types';
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
    const handler = (_event: IpcRendererEvent, code: string) => callback(code);
    ipcRenderer.on('GOOGLE_AUTH_CODE', handler);
    return () => ipcRenderer.off('GOOGLE_AUTH_CODE', handler);
  },
  changeLanguage: (lang: string) => {
    ipcRenderer.send(IPC_CHANNELS.CHANGE_LANGUAGE, lang);
  },
  onManualUpdateAvailable: (callback: (update: ManualUpdateInfo) => void) => {
    const handler = (_event: IpcRendererEvent, update: ManualUpdateInfo) => callback(update);
    ipcRenderer.on(IPC_CHANNELS.MANUAL_UPDATE_AVAILABLE, handler);
    ipcRenderer.send(IPC_CHANNELS.MANUAL_UPDATE_RENDERER_READY);
    return () => ipcRenderer.off(IPC_CHANNELS.MANUAL_UPDATE_AVAILABLE, handler);
  },
  onTrafficAuditEvent: (callback: (event: TrafficAuditEvent) => void) => {
    const handler = (_event: IpcRendererEvent, payload: unknown) => {
      const parsed = TrafficAuditEventSchema.safeParse(payload);
      if (parsed.success) {
        callback(parsed.data);
      }
    };
    ipcRenderer.on(IPC_CHANNELS.TRAFFIC_AUDIT_EVENT, handler);
    return () => ipcRenderer.off(IPC_CHANNELS.TRAFFIC_AUDIT_EVENT, handler);
  },
  checkForUpdates: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.CHECK_FOR_UPDATES);
  },
  downloadUpdate: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.DOWNLOAD_UPDATE);
  },
  installUpdate: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.INSTALL_UPDATE);
  },
  dismissManualUpdate: (version: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.DISMISS_MANUAL_UPDATE, version);
  },
  openExternalUrl: (url: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.OPEN_EXTERNAL_URL, url);
  },
  saveTrafficAuditBody: (bodyId: string, suggestedName: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.SAVE_TRAFFIC_AUDIT_BODY, bodyId, suggestedName);
  },
  ...(import.meta.env.ANTIGRAVITY_ENABLE_PERFORMANCE_RECORDER === '1'
    ? {
        startPerformanceRecording: (label: string) => {
          return ipcRenderer.invoke(IPC_CHANNELS.START_PERFORMANCE_RECORDING, label);
        },
        stopPerformanceRecording: (snapshot: RendererPerformanceSnapshot) => {
          return ipcRenderer.invoke(IPC_CHANNELS.STOP_PERFORMANCE_RECORDING, snapshot);
        },
      }
    : {}),
};

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('electron', electronBridge);
} else {
  window.electron = electronBridge;
}
