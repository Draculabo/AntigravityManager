/**
 * @created by https://github.com/abdul-zailani
 */
import { os } from '@orpc/server';
import { z } from 'zod';
import { sendTestNotification, getNotificationThresholds } from './handler';

export const notificationRouter = os.router({
  sendTestNotification: os.output(z.void()).handler(async () => {
    sendTestNotification();
  }),

  getThresholds: os
    .output(
      z.object({
        warningThreshold: z.number(),
        switchThreshold: z.number(),
      }),
    )
    .handler(async () => {
      return getNotificationThresholds();
    }),
});
