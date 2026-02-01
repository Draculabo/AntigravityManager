import { os } from '@orpc/server';
import { z } from 'zod';
import { sendTestNotification, getNotificationThresholds } from './handler';

export const notificationRouter = os.router({
  /**
   * Send a test notification to verify the system is working
   */
  sendTestNotification: os.output(z.void()).handler(async () => {
    sendTestNotification();
  }),

  /**
   * Get current notification thresholds from config
   */
  getThresholds: os
    .output(
      z.object({
        warningThreshold: z.number(),
        switchThreshold: z.number(),
      })
    )
    .handler(async () => {
      return getNotificationThresholds();
    }),
});
