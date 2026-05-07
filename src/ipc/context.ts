import { os } from '@orpc/server';
import type { BrowserWindow } from 'electron';

class IPCContext {
  public mainWindow: BrowserWindow | undefined;

  public setMainWindow(window: BrowserWindow) {
    this.mainWindow = window;
  }

  public get mainWindowContext() {
    // Return a middleware that checks for the window at execution time, not import time
    return os.middleware(({ next }) => {
      if (!this.mainWindow) {
        throw new Error('Main window is not set in IPC context.');
      }
      return next({
        context: {
          window: this.mainWindow,
        },
      });
    });
  }
}

export const ipcContext = new IPCContext();
