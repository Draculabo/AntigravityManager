/**
 * @created by https://github.com/abdul-zailani
 */
import { NotificationService } from '../../services/NotificationService';
import { logger } from '../../utils/logger';
/**
 * Test notification configuration
 * These are placeholder values used only for testing notification functionality
 */
const TEST_NOTIFICATION_CONFIG = {
  fromEmail: '[Test] Previous Account',
  toEmail: '[Test] Current Account',
} as const;

export function sendTestNotification(): void {
  logger.info('NotificationHandler: Sending test notification');
  try {
    NotificationService.clearDebounceCache();
    NotificationService.sendAutoSwitchNotification(
      TEST_NOTIFICATION_CONFIG.fromEmail,
      TEST_NOTIFICATION_CONFIG.toEmail,
    );
  } catch (error) {
    logger.error('NotificationHandler: Failed to send test notification', error);
  }
}

export function getNotificationThresholds(): {
  warningThreshold: number;
  switchThreshold: number;
} {
  return {
    warningThreshold: NotificationService.getWarningThreshold(),
    switchThreshold: NotificationService.getSwitchThreshold(),
  };
}
