import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { app, BrowserWindow, ipcMain } from 'electron';
import { os } from '@orpc/server';
import { RPCHandler } from '@orpc/server/message-port';
import { z } from 'zod';
import { IPC_CHANNELS } from '@/shared/constants';
import { getReleaseNotes } from '@/modules/app-shell/update/releaseNotesService';
import { openReleaseNotesLink } from '@/modules/app-shell/ipc/app/releaseNotes';
import {
  ReleaseNotesTargetSchema,
  ReleaseNotesResultSchema,
} from '@/modules/app-shell/update/releaseNotes.schema';
import { getTargetReleaseUrl } from '@/modules/app-shell/update/releaseNotesLinks';
import { previewContract, PreviewConfigurationSchema, SAMPLE_NOTES } from './release-notes-fixture';

let configuration = PreviewConfigurationSchema.parse(
  JSON.parse(process.env.AGM_RELEASE_NOTES_CONFIGURATION ?? '{}'),
);
let reads = 0;
let downloads = 0;
let installs = 0;
let cancellations = 0;
let window: BrowserWindow;
const status = () => ({ configuration, reads, downloads, installs, cancellations });
const notify = () => {
  window.webContents.send(IPC_CHANNELS.MANUAL_UPDATE_AVAILABLE, {
    version: configuration.tagName.slice(1),
    tagName: configuration.tagName,
    releaseName: configuration.tagName,
    releaseUrl: getTargetReleaseUrl(configuration.tagName),
    platform: z.enum(['win32', 'darwin', 'linux']).parse(process.platform),
    source: 'electron-updater',
    state: configuration.state,
    downloadPercent: configuration.state === 'downloaded' ? 100 : 35,
  } satisfies ManualUpdateInfo);
};

const handler = new RPCHandler({
  app: {
    releaseNotes: os
      .input(ReleaseNotesTargetSchema)
      .output(ReleaseNotesResultSchema)
      .handler(async ({ input, signal }) => {
        const mode = configuration.mode;
        const attempt = ++reads;
        if (mode === 'live') {
          return getReleaseNotes(input, signal);
        }
        try {
          await setTimeout(mode === 'slow' ? 30_000 : 500, undefined, { signal });
        } catch {
          cancellations++;
          return { status: 'error', tagName: input.tagName };
        }
        if (mode === 'retry' && attempt === 1) {
          return { status: 'error', tagName: input.tagName };
        }
        if (mode === 'empty') {
          return { status: 'empty', tagName: input.tagName, publishedAt: null };
        }
        return {
          status: 'ready',
          tagName: input.tagName,
          notes: SAMPLE_NOTES,
          publishedAt: '2026-10-08T00:00:00Z',
        };
      }),
    openReleaseNotesLink,
  },
  preview: {
    configure: previewContract.configure.handler(({ input }) => {
      configuration = input;
      reads = downloads = installs = cancellations = 0;
      notify();
      return status();
    }),
    status: previewContract.status.handler(status),
  },
});

async function openPreview() {
  app.on('window-all-closed', () => app.quit());
  await app.whenReady();
  window = new BrowserWindow({
    width: 1100,
    height: 800,
    show: process.env.AGM_RELEASE_NOTES_SHOW !== '0',
    title: 'Release notes — local validation',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
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
  ipcMain.on(IPC_CHANNELS.MANUAL_UPDATE_RENDERER_READY, notify);
  ipcMain.handle(IPC_CHANNELS.DOWNLOAD_UPDATE, () => {
    downloads++;
    configuration = { ...configuration, state: 'downloading' };
    notify();
    return { status: 'started' };
  });
  ipcMain.handle(IPC_CHANNELS.INSTALL_UPDATE, () => {
    installs++;
    return { status: 'started' };
  });
  ipcMain.handle(IPC_CHANNELS.DISMISS_MANUAL_UPDATE, () => undefined);
  ipcMain.handle(IPC_CHANNELS.CHECK_FOR_UPDATES, () => {
    notify();
    return { status: 'available' };
  });
  const url = z.url().parse(process.env.AGM_RELEASE_NOTES_URL);
  if (new URL(url).hostname !== '127.0.0.1') {
    throw new Error('The validation window requires its loopback renderer server');
  }
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, destination) => {
    if (destination !== url) {
      event.preventDefault();
    }
  });
  await window.loadURL(url);
  if (process.env.AGM_RELEASE_NOTES_SHOW !== '0') {
    window.show();
    window.focus();
    if (!window.isVisible()) {
      throw new Error('The release-notes preview window could not be shown');
    }
    console.log(
      `Release-notes window ready: mode=${configuration.mode}, tag=${configuration.tagName}.`,
    );
  }
}

void openPreview().catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});
