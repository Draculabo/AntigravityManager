/**
 * @created by https://github.com/abdul-zailani
 */
import { ipc } from '@/ipc/manager';
import { logger } from '@/utils/logger';

export async function sendTestNotification() {
  try {
    return await ipc.client.notification.sendTestNotification();
  } catch (error) {
    logger.error('Failed to send test notification', error);
    throw error;
  }
}
