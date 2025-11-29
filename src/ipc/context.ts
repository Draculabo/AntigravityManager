import { os } from "@orpc/server";
import { BrowserWindow } from "electron";

class IPCContext {
  public mainWindow: BrowserWindow | undefined;

  public setMainWindow(window: BrowserWindow) {
    this.mainWindow = window;
  }

  public get mainWindowContext() {
    if (!this.mainWindow) {
      throw new Error("Main window is not set in IPC context.");
    }

    return os.middleware(({ next }) =>
      next({
        context: {
          window: this.mainWindow!,
        },
      }),
    );
  }
}

export const ipcContext = new IPCContext();
