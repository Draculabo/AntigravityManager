import { app, Tray, Menu, nativeImage, type BrowserWindow } from 'electron';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import { getCloudAccountAdapter } from '@/modules/cloud-account/ipc/cloud-account-adapter';
import { logger } from '@/shared/logging/logger';
import { restoreExistingWindow } from '../../utils/windowActivation';
import { getTrayTexts } from './i18n';
import { configureTrayIcon, resolveTrayIconPath } from './icon';
import { getTrayQuotaText } from './quota';

type TrayAccount = Pick<CloudAccountView, 'email' | 'quota'>;
let tray: Tray | null = null;
let globalMainWindow: BrowserWindow | null = null;
let lastAccount: TrayAccount | null = null;
let lastLanguage = 'en';
let onQuitRequested: (() => void | Promise<void>) | null = null;
let accountReadVersion = 0;

export function isTrayReady(): boolean {
  return tray !== null;
}

export function setTrayMainWindow(mainWindow: BrowserWindow | null): void {
  globalMainWindow = mainWindow;
}

export function initTray(
  mainWindow: BrowserWindow,
  quitHandler?: () => void | Promise<void>,
): boolean {
  destroyTray();
  globalMainWindow = mainWindow;
  onQuitRequested = quitHandler ?? null;

  try {
    const iconPath = resolveTrayIconPath({
      inDevelopment: process.env.NODE_ENV === 'development',
      platform: process.platform,
      cwd: process.cwd(),
      resourcesPath: process.resourcesPath,
    });
    const icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      throw new Error(`Tray icon not found or invalid at path: ${iconPath}`);
    }

    configureTrayIcon(icon, process.platform);
    tray = new Tray(icon);
    tray.setToolTip('Antigravity Manager');
    tray.on('double-click', () => {
      const window = globalMainWindow;
      if (!window || window.isDestroyed()) {
        return;
      }
      if (window.isVisible() && !window.isMinimized()) {
        window.hide();
      } else {
        restoreExistingWindow(window);
      }
    });
    renderTrayMenu(tray, null);
  } catch (error) {
    logger.error('Failed to initialize tray', error);
    destroyTray();
    return false;
  }

  void refreshTrayAccount();
  return true;
}

/** Reconcile a presentation hint against the selected owner's current Classic snapshot. */
export async function refreshTrayAccount(): Promise<void> {
  const currentTray = tray;
  if (!currentTray) {
    return;
  }
  const adapter = getCloudAccountAdapter();
  const version = ++accountReadVersion;
  try {
    const accounts = await adapter.listViews();
    if (
      tray !== currentTray ||
      version !== accountReadVersion ||
      adapter !== getCloudAccountAdapter()
    ) {
      return;
    }
    const account = accounts.find((item) => item.is_active_classic) ?? null;
    renderTrayMenu(currentTray, account);
    lastAccount = account;
  } catch (error) {
    logger.warn('Failed to refresh current Classic account in tray', error);
  }
}

function renderTrayMenu(currentTray: Tray, account: TrayAccount | null): void {
  const texts = getTrayTexts(lastLanguage);
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: account
        ? `${texts.current}: ${account.email}`
        : `${texts.current}: ${texts.no_account}`,
      enabled: false,
    },
    ...getTrayQuotaText(account, texts).map((label) => ({ label, enabled: false })),
    { type: 'separator' },
    {
      label: texts.switch_next,
      click: async () => {
        try {
          const adapter = getCloudAccountAdapter();
          const accounts = await adapter.listViews();
          if (
            tray !== currentTray ||
            adapter !== getCloudAccountAdapter() ||
            accounts.length === 0
          ) {
            return;
          }

          const currentIndex = accounts.findIndex((item) => item.is_active_classic);
          const next = accounts[(currentIndex + 1) % accounts.length];
          await adapter.switchAccount(next.id, 'classic');
          if (tray !== currentTray || adapter !== getCloudAccountAdapter()) {
            return;
          }

          const window = globalMainWindow;
          if (window && !window.isDestroyed()) {
            window.webContents.send('tray://account-switched', next.id);
          }
          await refreshTrayAccount();
        } catch (error) {
          logger.error('Tray: Switch account failed', error);
        }
      },
    },
    {
      label: texts.refresh_current,
      click: async () => {
        try {
          const adapter = getCloudAccountAdapter();
          const accounts = await adapter.listViews();
          const current = accounts.find((item) => item.is_active_classic);
          if (tray !== currentTray || adapter !== getCloudAccountAdapter() || !current) {
            return;
          }

          await adapter.refreshQuota(current.id);
          if (tray !== currentTray || adapter !== getCloudAccountAdapter()) {
            return;
          }
          const window = globalMainWindow;
          if (window && !window.isDestroyed()) {
            window.webContents.send('tray://refresh-current');
          }
        } catch (error) {
          logger.error('Tray: Refresh quota failed', error);
        }
      },
    },
    { type: 'separator' },
    {
      label: texts.show_window,
      click: () => {
        if (globalMainWindow) {
          restoreExistingWindow(globalMainWindow);
        }
      },
    },
    { type: 'separator' },
    {
      label: texts.quit,
      click: () => {
        if (onQuitRequested) {
          void onQuitRequested();
          return;
        }
        app.quit();
      },
    },
  ];

  currentTray.setContextMenu(Menu.buildFromTemplate(template));
}

export function setTrayLanguage(lang: string): void {
  lastLanguage = lang;
  if (tray) {
    try {
      renderTrayMenu(tray, lastAccount);
    } catch (error) {
      logger.warn('Failed to update tray language', error);
    }
  }
}

export function destroyTray(): void {
  const currentTray = tray;
  tray = null;
  lastAccount = null;
  onQuitRequested = null;
  if (currentTray) {
    try {
      currentTray.destroy();
    } catch (error) {
      logger.error('Failed to destroy tray', error);
    }
  }
}
