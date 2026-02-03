/**
 * @created by https://github.com/abdul-zailani
 */
import { os } from '@orpc/server';
import { z } from 'zod';
import { sendTestNotification, getNotificationThresholds } from './handler';
import { logger } from '../../utils/logger';

export const notificationRouter = os.router({
  sendTestNotification: os.output(z.void()).handler(async () => {
    try {
      sendTestNotification();
    } catch (error) {
      logger.error('NotificationRouter: Failed to send test notification', error);
      throw error;
    }
  }),

  getThresholds: os
    .output(
      z.object({
        warningThreshold: z.number(),
        switchThreshold: z.number(),
      }),
    )
    .handler(async () => {
      try {
        return getNotificationThresholds();
      } catch (error) {
        logger.error('NotificationRouter: Failed to get notification thresholds', error);
        throw error;
      }
    }),
});

