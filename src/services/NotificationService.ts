import { Notification, nativeImage, app } from 'electron';
import path from 'path';
import { logger } from '../utils/logger';
import { ConfigManager } from '../ipc/config/manager';

/**
 * Notification types for the application
 */
export enum NotificationType {
  AUTO_SWITCH_SUCCESS = 'auto_switch_success',
  QUOTA_WARNING = 'quota_warning',
  ALL_DEPLETED = 'all_depleted',
}

/**
 * Debounce tracking to prevent notification spam
 */
const notificationDebounce: Map<string, number> = new Map();
const DEBOUNCE_DURATION_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Check if notifications are enabled in config
 */
function isNotificationsEnabled(): boolean {
  const config = ConfigManager.getCachedConfig() ?? ConfigManager.loadConfig();
  return config.notifications.enabled;
}

/**
 * Check if a notification should be sent (debounce check)
 * @param key Unique key for the notification (e.g., "quota_warning_user@email.com")
 */
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

/**
 * Get the icon path for notifications
 * @param type The type of notification icon
 */
function getNotificationIcon(type: 'success' | 'warning' | 'error'): Electron.NativeImage | undefined {
  try {
    // In production, icons are in resources folder
    // In development, they might be in src/assets
    const iconName = `notification-${type}.png`;
    const possiblePaths = [
      path.join(process.resourcesPath, 'assets', iconName),
      path.join(app.getAppPath(), 'src', 'assets', iconName),
      path.join(__dirname, '..', 'assets', iconName),
    ];

    for (const iconPath of possiblePaths) {
      try {
        const image = nativeImage.createFromPath(iconPath);
        if (!image.isEmpty()) {
          return image;
        }
      } catch {
        // Continue to next path
      }
    }
  } catch (error) {
    logger.warn('NotificationService: Failed to load notification icon', error);
  }
  return undefined;
}

/**
 * NotificationService handles all desktop notifications for the application.
 * It respects user preferences and implements debouncing to prevent spam.
 */
export class NotificationService {
  /**
   * Send a notification when auto-switch successfully switches accounts
   * @param fromEmail The email of the account switched from
   * @param toEmail The email of the account switched to
   */
  static sendAutoSwitchNotification(fromEmail: string, toEmail: string): void {
    if (!isNotificationsEnabled()) {
      logger.info('NotificationService: Notifications disabled, skipping auto-switch notification');
      return;
    }

    // Use both emails in key to allow notifications for different account pairs
    const key = `${NotificationType.AUTO_SWITCH_SUCCESS}_${fromEmail}_${toEmail}`;
    if (!shouldSendNotification(key)) {
      return;
    }

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

  /**
   * Send a warning notification when quota is running low
   * @param email The email of the account with low quota
   * @param percentage The current quota percentage
   */
  static sendQuotaWarningNotification(email: string, percentage: number): void {
    if (!isNotificationsEnabled()) {
      logger.info('NotificationService: Notifications disabled, skipping quota warning');
      return;
    }

    const key = `${NotificationType.QUOTA_WARNING}_${email}`;
    if (!shouldSendNotification(key)) {
      return;
    }

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

  /**
   * Send a critical notification when all accounts are depleted or rate-limited
   */
  static sendAllDepletedNotification(): void {
    if (!isNotificationsEnabled()) {
      logger.info('NotificationService: Notifications disabled, skipping all-depleted notification');
      return;
    }

    const key = `${NotificationType.ALL_DEPLETED}`;
    if (!shouldSendNotification(key)) {
      return;
    }

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
   * Clear debounce cache for testing or reset purposes
   */
  static clearDebounceCache(): void {
    notificationDebounce.clear();
    logger.info('NotificationService: Cleared debounce cache');
  }

  /**
   * Get the warning threshold from config
   */
  static getWarningThreshold(): number {
    const config = ConfigManager.getCachedConfig() ?? ConfigManager.loadConfig();
    return config.notifications.quota_warning_threshold;
  }

  /**
   * Get the switch threshold from config
   */
  static getSwitchThreshold(): number {
    const config = ConfigManager.getCachedConfig() ?? ConfigManager.loadConfig();
    return config.notifications.quota_switch_threshold;
  }
}
