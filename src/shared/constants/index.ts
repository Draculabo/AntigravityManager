export const LOCAL_STORAGE_KEYS = {
  LANGUAGE: 'lang',
  THEME: 'theme',
};

export const IPC_CHANNELS = {
  START_ORPC_SERVER: 'start-orpc-server',
  CHANGE_LANGUAGE: 'change-language',
  CHECK_FOR_UPDATES: 'check-for-updates',
  DOWNLOAD_UPDATE: 'download-update',
  INSTALL_UPDATE: 'install-update',
  DISMISS_MANUAL_UPDATE: 'dismiss-manual-update',
  MANUAL_UPDATE_AVAILABLE: 'manual-update-available',
  MANUAL_UPDATE_RENDERER_READY: 'manual-update-renderer-ready',
  GET_OBSERVABILITY_CONFIG: 'get-observability-config',
  OPEN_EXTERNAL_URL: 'open-external-url',
  START_PERFORMANCE_RECORDING: 'start-performance-recording',
  STOP_PERFORMANCE_RECORDING: 'stop-performance-recording',
};
