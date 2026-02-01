import { NotificationService } from '../../services/NotificationService';
import { logger } from '../../utils/logger';

/**
 * Send a test notification to verify the notification system is working
 */
export function sendTestNotification(): void {
  logger.info('NotificationHandler: Sending test notification');

  // Clear debounce cache first to ensure test notification is sent
  NotificationService.clearDebounceCache();

  // Send a test notification using the success icon
  NotificationService.sendAutoSwitchNotification(
    'test@example.com',
    'current@account.com'
  );
}

/**
 * Get current notification configuration thresholds
 */
export function getNotificationThresholds(): {
  warningThreshold: number;
  switchThreshold: number;
} {
  return {
    warningThreshold: NotificationService.getWarningThreshold(),
    switchThreshold: NotificationService.getSwitchThreshold(),
  };
}
