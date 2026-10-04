import { os } from '@orpc/server';
import { DesktopPreferencesSchema, DesktopPreferencesUpdateSchema } from '../service-config.schema';
import {
  createServiceConfigRouter,
  createAccountAlertPolicyRouter,
  configurationUnavailable,
} from '../service-config.router';
import { getConfigAdapter } from './config-adapter';
import { loadDesktopPreferences, saveDesktopPreferences } from './handlers';

export const configRouter = os.router({
  accountAlertPolicy: createAccountAlertPolicyRouter({
    read: () => getConfigAdapter().accountAlertPolicy.read(),
    update: (input) => getConfigAdapter().accountAlertPolicy.update(input),
  }),
  service: createServiceConfigRouter({
    read: () => getConfigAdapter().read(),
    update: (input) => getConfigAdapter().update(input),
    writeSecret: (input) => getConfigAdapter().writeSecret(input),
    revealSecret: (name) => getConfigAdapter().revealSecret(name),
    generateKey: () => getConfigAdapter().generateKey(),
  }),
  desktop: os.router({
    load: os.output(DesktopPreferencesSchema).handler(async () => {
      try {
        return await loadDesktopPreferences();
      } catch {
        throw configurationUnavailable();
      }
    }),
    save: os
      .input(DesktopPreferencesUpdateSchema)
      .output(DesktopPreferencesSchema)
      .handler(async ({ input }) => {
        try {
          return await saveDesktopPreferences(input);
        } catch {
          throw configurationUnavailable();
        }
      }),
  }),
});
