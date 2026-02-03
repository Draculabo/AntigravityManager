import { app } from './app';
import { theme } from './theme';
import { window } from './window';
import { databaseRouter } from './database/router';
import { accountRouter } from './account/router';
import { cloudRouter } from './cloud/router';
import { configRouter } from './config/router';
import { gatewayRouter } from './gateway/router';
import { notificationRouter } from './notification/router';
import { systemRouter } from './system/router';

import { os } from '@orpc/server';
import { z } from 'zod';
import { isProcessRunning, closeAntigravity, startAntigravity } from './process/handler';

// Log middleware setup
const logMiddleware = os.middleware(async (opts: any) => {
  const { next, path, meta } = opts;
  const requestPath = path || meta?.path || 'unknown';

  try {
    const result = await next({});
    return result;
  } catch (err) {
    console.error(`[ORPC] Error in handler for ${JSON.stringify(requestPath)}:`, err);
    throw err;
  }
});

// Explicit Router Definition
export const router = os.use(logMiddleware).router({
  ping: os.output(z.string()).handler(async () => 'pong'),

  theme,
  window,
  app,
  database: databaseRouter,

  // Inline process router to ensure structure
  proc: os.router({
    isProcessRunning: os.output(z.boolean()).handler(async () => {
      return await isProcessRunning();
    }),
    closeAntigravity: os.output(z.void()).handler(async () => {
      await closeAntigravity();
    }),
    startAntigravity: os.output(z.void()).handler(async () => {
      await startAntigravity();
    }),
  }),

  account: accountRouter,
  cloud: cloudRouter,
  config: configRouter,
  gateway: gatewayRouter,
  system: systemRouter,
  notification: notificationRouter,
});

