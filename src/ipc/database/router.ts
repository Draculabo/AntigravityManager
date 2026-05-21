import { z } from 'zod';
import { os } from '@orpc/server';
import { backupAccount, restoreAccount, getCurrentAccountInfo } from './handler';
import { AccountBackupDataSchema, AccountInfoSchema, AccountSchema } from '../../types/account';
import { ConfigManager } from '../config/manager';

function getEdition() {
  const config = ConfigManager.getCachedConfig() || ConfigManager.loadConfig();
  return config.ideEdition || undefined;
}

export const databaseRouter = os.router({
  backupAccount: os
    .input(AccountSchema)
    .output(AccountBackupDataSchema)
    .handler(async ({ input }) => {
      return backupAccount(input, getEdition());
    }),

  restoreAccount: os
    .input(AccountBackupDataSchema)
    .output(z.void())
    .handler(async ({ input }) => {
      restoreAccount(input, getEdition());
    }),

  getCurrentAccountInfo: os.output(AccountInfoSchema).handler(async () => {
    return getCurrentAccountInfo(getEdition());
  }),
});
