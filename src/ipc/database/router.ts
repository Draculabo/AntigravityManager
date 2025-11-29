import { z } from "zod";
import { os } from "@orpc/server";
import {
  backupAccount,
  restoreAccount,
  getCurrentAccountInfo,
} from "./handler";
import {
  AccountBackupDataSchema,
  AccountInfoSchema,
  AccountSchema,
} from "../../types/account";

export const databaseRouter = os.router({
  backupAccount: os
    .input(AccountSchema)
    .output(AccountBackupDataSchema)
    .handler(async ({ input }) => {
      return backupAccount(input);
    }),

  restoreAccount: os
    .input(AccountBackupDataSchema)
    .output(z.void())
    .handler(async ({ input }) => {
      restoreAccount(input);
    }),

  getCurrentAccountInfo: os.output(AccountInfoSchema).handler(async () => {
    return getCurrentAccountInfo();
  }),
});
