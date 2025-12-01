import { app } from './app';
import { theme } from './theme';
import { window } from './window';
import { databaseRouter } from './database/router';
import { processRouter } from './process/router';
import { accountRouter } from './account/router';
import { cloudRouter } from './cloud/router';

export const router = {
  theme,
  window,
  app,
  database: databaseRouter,
  process: processRouter,
  account: accountRouter,
  cloud: cloudRouter,
};
