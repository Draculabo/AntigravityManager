import { app } from './app';
import { systemHandler } from './system/handler';
import { theme } from './theme';
import { window } from './window';

export const appShellRouter = {
  app,
  system: systemHandler,
  theme,
  window,
};
