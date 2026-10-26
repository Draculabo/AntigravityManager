import path from 'node:path';
import { release, version } from 'node:os';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { os } from '@orpc/server';
import { RPCHandler } from '@orpc/server/message-port';
import { z } from 'zod';
import { IPC_CHANNELS } from '@/shared/constants';
import { BugReportEnvironmentSchema } from '@/modules/app-shell/bug-report-environment';
import { BUG_REPORT_URL } from '@/modules/app-shell/bug-report';
import { setThemeMode } from '@/modules/app-shell/ipc/theme/handlers';
import { createDiagnosticLogDesktopRouter } from '@/modules/app-shell/diagnostic-logs/desktop-router';
import {
  createDiagnosticLogDesktopService,
  writeDiagnosticAttachment,
} from '@/modules/app-shell/diagnostic-logs/desktop-service';
import { readDiagnosticLogs } from '@/modules/app-shell/diagnostic-logs/read-logs';

async function openPreview() {
  app.on('window-all-closed', () => app.quit());
  await app.whenReady();
  // The demo reads only these synthetic logs inside its isolated profile.
  const logDirectory = path.join(app.getPath('userData'), 'synthetic-logs');
  await mkdir(logDirectory, { recursive: true });
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  await writeFile(
    path.join(logDirectory, `app-${date}.log`),
    `[${now.toISOString()}] [ERROR] Synthetic failure {"code":"ECONNRESET","status":502,"prompt":"demo-private-prompt","email":"demo@example.invalid","access_token":"demo-private-token"}\n`,
  );
  const diagnosticLogs = createDiagnosticLogDesktopRouter(
    createDiagnosticLogDesktopService({
      read: async (until) => [await readDiagnosticLogs('app', until, logDirectory)],
      now: Date.now,
      write: (filePath, text) => writeDiagnosticAttachment(filePath, text, logDirectory),
      choose: async (defaultPath) => {
        const selection = await dialog.showSaveDialog({
          defaultPath,
          filters: [{ name: 'Text', extensions: ['txt'] }],
        });
        return selection.canceled ? null : (selection.filePath ?? null);
      },
    }),
  );
  const url = z.url().parse(process.env.AGM_ERROR_PREVIEW_URL);
  if (new URL(url).hostname !== '127.0.0.1') {
    throw new Error('The demo requires its loopback renderer server.');
  }
  const window = new BrowserWindow({
    width: 1100,
    height: 800,
    show: false,
    title: 'Error notifications — interactive demo',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const handler = new RPCHandler({
    theme: {
      setThemeMode,
    },
    app: {
      diagnosticLogs,
      bugReportEnvironment: os.output(BugReportEnvironmentSchema).handler(() => ({
        appVersion: z
          .string()
          .max(100)
          .parse(process.env.AGM_ERROR_PREVIEW_VERSION ?? app.getVersion()),
        platform: process.platform,
        osVersion: `${version()} (${release()})`,
        architecture: process.arch,
        electronVersion: process.versions.electron ?? 'Unavailable',
        nodeVersion: process.versions.node,
      })),
    },
  });
  ipcMain.on(IPC_CHANNELS.START_ORPC_SERVER, (event) => {
    if (event.sender !== window.webContents || event.ports.length !== 1) {
      return;
    }
    const [port] = event.ports;
    port.start();
    handler.upgrade(port);
  });
  ipcMain.handle(IPC_CHANNELS.OPEN_EXTERNAL_URL, async (event, destination: unknown) => {
    if (event.sender !== window.webContents || destination !== BUG_REPORT_URL) {
      throw new Error('The demo only opens its GitHub bug-report template.');
    }
    await shell.openExternal(BUG_REPORT_URL);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, destination) => {
    if (destination !== url) {
      event.preventDefault();
    }
  });
  await window.loadURL(url);
  if (process.env.AGM_ERROR_PREVIEW_SHOW !== '0') {
    window.show();
    window.focus();
    console.log('Error-notification demo ready.');
  }
}

void openPreview().catch(() => {
  console.error('The isolated error-notification window could not open.');
  app.exit(1);
});
