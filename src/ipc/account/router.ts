import { z } from "zod";
import { os } from "@orpc/server";
import {
  listAccountsData,
  addAccountSnapshot,
  switchAccount,
  deleteAccount,
} from "./handler";
import { AccountSchema } from "../../types/account";

export const accountRouter = os.router({
  listAccounts: os.output(z.array(AccountSchema)).handler(async () => {
    return listAccountsData();
  }),

  addAccountSnapshot: os.output(AccountSchema).handler(async () => {
    return addAccountSnapshot();
  }),

  switchAccount: os
    .input(z.object({ accountId: z.string() }))
    .output(z.void())
    .handler(async ({ input }) => {
      await switchAccount(input.accountId);
    }),

  deleteAccount: os
    .input(z.object({ accountId: z.string() }))
    .output(z.void())
    .handler(async ({ input }) => {
      await deleteAccount(input.accountId);
    }),
});
