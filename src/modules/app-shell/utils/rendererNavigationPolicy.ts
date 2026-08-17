import type { BrowserWindow } from 'electron';

const configuredWebContents = new WeakSet<BrowserWindow['webContents']>();

export function installRendererNavigationPolicy(window: BrowserWindow): void {
  const { webContents } = window;
  if (configuredWebContents.has(webContents)) {
    return;
  }
  configuredWebContents.add(webContents);

  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  webContents.on('will-frame-navigate', (event) => {
    event.preventDefault();
  });

  webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}
