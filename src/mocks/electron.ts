// Minimal Electron mock for unit tests
export const app = {
  getPath: () => '/tmp',
  getVersion: () => '0.0.0',
};

export const ipcMain = {
  on: () => {},
  handle: () => {},
  removeHandler: () => {},
};

export const ipcRenderer = {
  on: () => {},
  invoke: () => Promise.resolve(),
  send: () => {},
};

export class Notification {
  constructor(_opts?: { title?: string; body?: string; silent?: boolean }) {}
  show() {}
}

export const shell = {
  openPath: () => Promise.resolve(''),
  openExternal: () => Promise.resolve(),
};

export const dialog = {
  showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
};

export const nativeTheme = {
  themeSource: 'system',
  shouldUseDarkColors: false,
};

export default {
  app,
  ipcMain,
  ipcRenderer,
  Notification,
  shell,
  dialog,
  nativeTheme,
};
