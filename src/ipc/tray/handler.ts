import { app, Tray, Menu, nativeImage, BrowserWindow } from 'electron';
import path from 'path';
import { CloudAccount } from '../../types/cloudAccount';
import { logger } from '../../utils/logger';
import { getTrayTexts } from './i18n';
import { CloudAccountRepo } from '../database/cloudHandler';
import { GoogleAPIService } from '../../services/GoogleAPIService';

let tray: Tray | null = null;
let globalMainWindow: BrowserWindow | null = null;
let lastAccount: CloudAccount | null = null;
let lastLanguage: string = 'en';

function getQuotaText(account: CloudAccount | null, texts: any): string[] {
  if (!account) return [`${texts.quota}: --`];
  if (!account.quota || !account.quota.models) return [`${texts.quota}: ${texts.unknown_quota}`];

  const lines: string[] = [];
  const models = account.quota.models;

  let gHigh = 0;
  let gImage = 0;
  let claude = 0;

  for (const [key, val] of Object.entries(models)) {
    const k = key.toLowerCase();
    if (k.includes('high')) gHigh = val.percentage;
    else if (k.includes('image')) gImage = val.percentage;
    else if (k.includes('claude')) claude = val.percentage;
  }

  lines.push(`Gemini High: ${gHigh}%`);
  lines.push(`Gemini Image: ${gImage}%`);
  lines.push(`Claude 4.5: ${claude}%`);

  return lines;
}

export function initTray(mainWindow: BrowserWindow) {
  globalMainWindow = mainWindow;

  // PATCH 3: Destroy existing tray before creating new one (prevents zombie tray icons)
  if (tray) {
    tray.destroy();
    tray = null;
    logger.info('Destroyed existing tray before creating new one');
  }

  const inDevelopment = process.env.NODE_ENV === 'development';
  const iconPath = inDevelopment
    ? path.join(process.cwd(), 'src/assets/tray.png')
    : path.join(process.resourcesPath, 'assets/tray.png');

  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon);
  tray.setToolTip('Antigravity Manager');

  tray.on('double-click', () => {
    if (globalMainWindow) {
      if (globalMainWindow.isVisible()) {
        globalMainWindow.hide();
      } else {
        globalMainWindow.show();
        globalMainWindow.focus();
      }
    }
  });

  updateTrayMenu(null);
}

export function updateTrayMenu(account: CloudAccount | null, language?: string) {
  lastAccount = account;
  if (language) {
    lastLanguage = language;
  }

  if (!tray || !globalMainWindow) return;

  const texts = getTrayTexts(lastLanguage);
  const quotaLines = getQuotaText(account, texts);

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: account
        ? `${texts.current}: ${account.email}`
        : `${texts.current}: ${texts.no_account}`,
      enabled: false,
    },
    ...quotaLines.map((line) => ({ label: line, enabled: false })),
    { type: 'separator' },
    {
      label: texts.switch_next,
      click: async () => {
        try {
          const accounts = await CloudAccountRepo.getAccounts();
          if (accounts.length === 0) return;

          const current = accounts.find((a) => a.is_active);
          let nextIndex = 0;
          if (current) {
            const idx = accounts.findIndex((a) => a.id === current.id);
            nextIndex = (idx + 1) % accounts.length;
          }
          const next = accounts[nextIndex];

          CloudAccountRepo.setActive(next.id);
          logger.info(`Tray: Switched to account ${next.email}`);

          updateTrayMenu(next, lastLanguage);

          if (globalMainWindow) {
            globalMainWindow.webContents.send('tray://account-switched', next.id);
          }
        } catch (e) {
          logger.error('Tray: Switch account failed', e);
        }
      },
    },
    {
      label: texts.refresh_current,
      click: async () => {
        try {
          const accounts = await CloudAccountRepo.getAccounts();
          const current = accounts.find((a) => a.is_active);
          if (!current) return;

          logger.info(`Tray: Refreshing quota for ${current.email}`);

          const quota = await GoogleAPIService.fetchQuota(current.token.access_token);
          await CloudAccountRepo.updateQuota(current.id, quota);

          // Reload account to get updated obj
          const updated = await CloudAccountRepo.getAccount(current.id);
          if (updated) updateTrayMenu(updated, lastLanguage);

          if (globalMainWindow) {
            globalMainWindow.webContents.send('tray://refresh-current');
          }
        } catch (e) {
          logger.error('Tray: Refresh quota failed', e);
        }
      },
    },
    { type: 'separator' },
    {
      label: texts.show_window,
      click: () => {
        globalMainWindow?.show();
        globalMainWindow?.focus();
      },
    },
    { type: 'separator' },
    {
      label: texts.quit,
      click: () => {
        app.quit();
      },
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  tray.setContextMenu(menu);
}

export function setTrayLanguage(lang: string) {
  updateTrayMenu(lastAccount, lang);
}

export function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
    logger.info('Tray destroyed');
  }
}
