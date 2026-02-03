/**
 * @created by https://github.com/abdul-zailani
 */
import { Notification, nativeImage, app } from 'electron';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger';
import { ConfigManager } from '../ipc/config/manager';
import { DEFAULT_APP_CONFIG } from '../types/config';

export enum NotificationType {
  AUTO_SWITCH_SUCCESS = 'auto_switch_success',
  SWITCH_FAILED = 'switch_failed',
  QUOTA_WARNING = 'quota_warning',
  ALL_DEPLETED = 'all_depleted',
}

const notificationDebounce: Map<string, number> = new Map();
const DEBOUNCE_DURATION_MS = 5 * 60 * 1000;

function isNotificationsEnabled(): boolean {
  const config = ConfigManager.getCachedConfig() ?? ConfigManager.loadConfig();
  return config?.notifications?.enabled ?? DEFAULT_APP_CONFIG.notifications.enabled;
}

function shouldSendNotification(key: string): boolean {
  const lastSent = notificationDebounce.get(key);
  const now = Date.now();

  if (lastSent && now - lastSent < DEBOUNCE_DURATION_MS) {
    logger.info(`NotificationService: Debounced notification for key: ${key}`);
    return false;
  }

  notificationDebounce.set(key, now);
  return true;
}

function getNotificationIcon(
  type: 'success' | 'warning' | 'error',
): Electron.NativeImage | undefined {
  try {
    const iconName = `notification-${type}.png`;
    const fallbackName = 'icon.png';

    // 1. Try specific icons first, then try the generic app icon
    const iconTypes = [iconName, fallbackName];

    for (const name of iconTypes) {
      const possiblePaths = [
        path.join(process.resourcesPath, 'assets', name),
        path.join(app.getAppPath(), 'src', 'assets', name),
        path.join(__dirname, '..', 'assets', name),
      ];

      for (const iconPath of possiblePaths) {
        try {
          // Check if path exists before trying nativeImage to avoid unnecessary overhead
          if (fs.existsSync(iconPath)) {
            const image = nativeImage.createFromPath(iconPath);
            if (!image.isEmpty()) {
              return image;
            }
          }
        } catch {
          // Continue to next path
        }
      }
    }
  } catch (error) {
    logger.warn('NotificationService: Failed to load notification icon', error);
  }
  return undefined;
}

export class NotificationService {
  static sendAutoSwitchNotification(fromEmail: string, toEmail: string): void {
    if (!isNotificationsEnabled()) {
      logger.info('NotificationService: Notifications disabled, skipping auto-switch');
      return;
    }

    const key = `${NotificationType.AUTO_SWITCH_SUCCESS}_${fromEmail}_${toEmail}`;
    if (!shouldSendNotification(key)) return;

    try {
      const notification = new Notification({
        title: 'Account Switched',
        body: `Switched from ${fromEmail} to ${toEmail}`,
        icon: getNotificationIcon('success'),
        silent: false,
      });

      notification.show();
      logger.info(`NotificationService: Sent auto-switch notification: ${fromEmail} -> ${toEmail}`);
    } catch (error) {
      logger.error('NotificationService: Failed to send auto-switch notification', error);
    }
  }

  static sendQuotaWarningNotification(email: string, percentage: number): void {
    if (!isNotificationsEnabled()) {
      logger.info('NotificationService: Notifications disabled, skipping quota warning');
      return;
    }

    const key = `${NotificationType.QUOTA_WARNING}_${email}`;
    if (!shouldSendNotification(key)) return;

    try {
      const notification = new Notification({
        title: 'Low Quota Warning',
        body: `${email} has ${percentage.toFixed(1)}% quota remaining`,
        icon: getNotificationIcon('warning'),
        silent: false,
      });

      notification.show();
      logger.info(`NotificationService: Sent quota warning for ${email}: ${percentage}%`);
    } catch (error) {
      logger.error('NotificationService: Failed to send quota warning notification', error);
    }
  }

  static sendAllDepletedNotification(): void {
    if (!isNotificationsEnabled()) {
      logger.info('NotificationService: Notifications disabled, skipping all-depleted');
      return;
    }

    const key = `${NotificationType.ALL_DEPLETED}`;
    if (!shouldSendNotification(key)) return;

    try {
      const notification = new Notification({
        title: 'All Accounts Depleted',
        body: 'No healthy accounts available. Please add more accounts.',
        icon: getNotificationIcon('error'),
        urgency: 'critical',
        silent: false,
      });

      notification.show();
      logger.info('NotificationService: Sent all-depleted notification');
    } catch (error) {
      logger.error('NotificationService: Failed to send all-depleted notification', error);
    }
  }

  /**
   * Send a notification when auto-switch fails.
   * @param fromEmail The email of the account being switched from
   * @param toEmail The email of the account that was attempted to switch to
   * @param error The error that caused the failure
   */
  static sendSwitchFailedNotification(fromEmail: string, toEmail: string, error: unknown): void {
    if (!isNotificationsEnabled()) {
      logger.info('NotificationService: Notifications disabled, skipping switch-failed');
      return;
    }

    const key = `${NotificationType.SWITCH_FAILED}`;
    if (!shouldSendNotification(key)) return;

    try {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const notification = new Notification({
        title: 'Account Switch Failed',
        body: `Failed to switch from ${fromEmail} to ${toEmail}: ${errorMessage}`,
        icon: getNotificationIcon('error'),
        urgency: 'critical',
        silent: false,
      });

      notification.show();
      logger.info(`NotificationService: Sent switch-failed notification: ${fromEmail} -> ${toEmail}`);
    } catch (notifError) {
      logger.error('NotificationService: Failed to send switch-failed notification', notifError);
    }
  }

  static clearDebounceCache(): void {
    notificationDebounce.clear();
    logger.info('NotificationService: Cleared debounce cache');
  }

  static getWarningThreshold(): number {
    const config = ConfigManager.getCachedConfig() ?? ConfigManager.loadConfig();
    return config?.notifications?.quota_warning_threshold ?? DEFAULT_APP_CONFIG.notifications.quota_warning_threshold;
  }

  static async getWarningThresholdAsync(): Promise<number> {
    const config = ConfigManager.getCachedConfig() ?? (await ConfigManager.loadConfigAsync());
    return config?.notifications?.quota_warning_threshold ?? DEFAULT_APP_CONFIG.notifications.quota_warning_threshold;
  }

  static getSwitchThreshold(): number {
    const config = ConfigManager.getCachedConfig() ?? ConfigManager.loadConfig();
    return config?.notifications?.quota_switch_threshold ?? DEFAULT_APP_CONFIG.notifications.quota_switch_threshold;
  }

  static async getSwitchThresholdAsync(): Promise<number> {
    const config = ConfigManager.getCachedConfig() ?? (await ConfigManager.loadConfigAsync());
    return config?.notifications?.quota_switch_threshold ?? DEFAULT_APP_CONFIG.notifications.quota_switch_threshold;
  }
}
