import { z } from 'zod';
import { os } from '@orpc/server';
import {
  addGoogleAccount,
  listCloudAccounts,
  deleteCloudAccount,
  refreshAccountQuota,
} from './handler';
import { CloudAccountSchema } from '../../types/cloudAccount';

export const cloudRouter = os.router({
  addGoogleAccount: os
    .input(z.object({ authCode: z.string() }))
    .output(CloudAccountSchema)
    .handler(async ({ input }) => {
      return addGoogleAccount(input.authCode);
    }),

  listCloudAccounts: os.output(z.array(CloudAccountSchema)).handler(async () => {
    return listCloudAccounts();
  }),

  deleteCloudAccount: os
    .input(z.object({ accountId: z.string() }))
    .output(z.void())
    .handler(async ({ input }) => {
      await deleteCloudAccount(input.accountId);
    }),

  refreshAccountQuota: os
    .input(z.object({ accountId: z.string() }))
    .output(CloudAccountSchema)
    .handler(async ({ input }) => {
      return refreshAccountQuota(input.accountId);
    }),

  switchCloudAccount: os
    .input(z.object({ accountId: z.string() }))
    .output(z.void())
    .handler(async ({ input }) => {
      // Dynamic import to avoid circular dependency issues at runtime if any, though handler handles it
      const { switchCloudAccount } = require('./handler');
      await switchCloudAccount(input.accountId);
    }),

  getAutoSwitchEnabled: os.output(z.boolean()).handler(async () => {
    const { getAutoSwitchEnabled } = require('./handler');
    return getAutoSwitchEnabled();
  }),

  setAutoSwitchEnabled: os
    .input(z.object({ enabled: z.boolean() }))
    .output(z.void())
    .handler(async ({ input }) => {
      const { setAutoSwitchEnabled } = require('./handler');
      setAutoSwitchEnabled(input.enabled);
    }),

  forcePollCloudMonitor: os.output(z.void()).handler(async () => {
    const { forcePollCloudMonitor } = require('./handler');
    await forcePollCloudMonitor();
  }),

  syncLocalAccount: os.output(CloudAccountSchema.nullable()).handler(async () => {
    const { CloudAccountRepo } = require('../../ipc/database/cloudHandler');
    return await CloudAccountRepo.syncFromIDE();
  }),
});
