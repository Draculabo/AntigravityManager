/**
 * @created by https://github.com/abdul-zailani
 */
import { NotificationService } from '../../services/NotificationService';
import { logger } from '../../utils/logger';

export function sendTestNotification(): void {
  logger.info('NotificationHandler: Sending test notification');
  NotificationService.clearDebounceCache();
  NotificationService.sendAutoSwitchNotification('test@example.com', 'current@account.com');
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
