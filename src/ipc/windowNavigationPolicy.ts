import type { BrowserWindow, WebContents } from 'electron';

const securedWebContents = new WeakSet<WebContents>();

export function applyMainWindowNavigationPolicy(window: BrowserWindow) {
  const contents = window.webContents;
  if (securedWebContents.has(contents)) {
    return;
  }
  securedWebContents.add(contents);

  contents.setWindowOpenHandler(() => ({ action: 'deny' }));

  contents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  contents.on('will-frame-navigate', (event) => {
    event.preventDefault();
  });

  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}
