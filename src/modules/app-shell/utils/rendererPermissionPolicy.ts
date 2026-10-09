import type { BrowserWindow, Session } from 'electron';

const configuredSessions = new WeakSet<Session>();

export function installRendererPermissionPolicy(window: BrowserWindow): void {
  const rendererSession = window.webContents.session;

  if (configuredSessions.has(rendererSession)) {
    return;
  }

  rendererSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  rendererSession.setPermissionCheckHandler(() => false);

  configuredSessions.add(rendererSession);
}
