import { app } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from './logger';
import { AppConfig } from '../types/config';

export const AUTO_START_ARG = '--autostart';
const LINUX_AUTOSTART_FILENAME = 'antigravity-manager.desktop';

function getLinuxAutoStartPath() {
  const dir = path.join(os.homedir(), '.config', 'autostart');
  return path.join(dir, LINUX_AUTOSTART_FILENAME);
}

export function isAutoStartLaunch(argv = process.argv) {
  if (process.platform === 'linux') {
    return argv.includes(AUTO_START_ARG);
  }

  if (process.platform === 'win32' || process.platform === 'darwin') {
    try {
      const settings = app.getLoginItemSettings();
      return settings.wasOpenedAtLogin;
    } catch (error) {
      logger.error('AutoStart: Failed to read login item settings', error);
    }
  }

  return false;
}

function syncWindowsOrMacAutoStart(enabled: boolean) {
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: enabled,
      path: process.execPath,
      args: enabled ? [AUTO_START_ARG] : [],
    });
    const settings = app.getLoginItemSettings();
    if (settings.openAtLogin !== enabled) {
      logger.warn(
        `AutoStart: Login item mismatch (expected ${enabled}, actual ${settings.openAtLogin})`,
      );
    }
    logger.info(`AutoStart: Login item set to ${enabled}`);
  } catch (error) {
    logger.error('AutoStart: Failed to update login item settings', error);
  }
}

function cleanupLinuxAutoStartEntries(currentPath: string) {
  const autoStartDir = path.dirname(currentPath);
  if (!fs.existsSync(autoStartDir)) {
    return;
  }

  const legacyNames = [
    `${app.getName()}.desktop`,
    `${app.getName().replace(/\s+/g, '')}.desktop`,
    'Antigravity Manager.desktop',
    'AntigravityManager.desktop',
  ];

  for (const name of legacyNames) {
    const candidate = path.join(autoStartDir, name);
    if (candidate === currentPath) {
      continue;
    }
    if (fs.existsSync(candidate)) {
      try {
        fs.unlinkSync(candidate);
        logger.info(`AutoStart: Removed legacy autostart entry ${candidate}`);
      } catch (error) {
        logger.warn('AutoStart: Failed to remove legacy autostart entry', error);
      }
    }
  }
}

function syncLinuxAutoStart(enabled: boolean) {
  const autoStartPath = getLinuxAutoStartPath();

  if (!enabled) {
    if (fs.existsSync(autoStartPath)) {
      fs.unlinkSync(autoStartPath);
      logger.info('AutoStart: Removed Linux autostart entry');
    }
    cleanupLinuxAutoStartEntries(autoStartPath);
    return;
  }

  const autoStartDir = path.dirname(autoStartPath);
  if (!fs.existsSync(autoStartDir)) {
    fs.mkdirSync(autoStartDir, { recursive: true });
  }

  const execPath = process.execPath.replace(/"/g, '\\"');
  const content = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${app.getName()}`,
    `Exec="${execPath}" ${AUTO_START_ARG}`,
    'X-GNOME-Autostart-enabled=true',
    'Hidden=false',
    'NoDisplay=false',
  ].join('\n');

  cleanupLinuxAutoStartEntries(autoStartPath);
  fs.writeFileSync(autoStartPath, content, 'utf-8');
  logger.info('AutoStart: Created Linux autostart entry');
}

export function syncAutoStart(config: AppConfig) {
  const enabled = Boolean(config.auto_startup);

  if (process.platform === 'win32' || process.platform === 'darwin') {
    syncWindowsOrMacAutoStart(enabled);
    return;
  }

  if (process.platform === 'linux') {
    syncLinuxAutoStart(enabled);
  }
}
