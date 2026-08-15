import type { BrowserWindow, Session } from 'electron';

const configuredSessions = new WeakSet<Session>();

export function configureRendererPermissionPolicy(window: BrowserWindow): void {
  const session = window.webContents.session;
  if (configuredSessions.has(session)) {
    return;
  }

  session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.setPermissionCheckHandler(() => false);
  configuredSessions.add(session);
}
