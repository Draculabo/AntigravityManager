import { os } from '@orpc/server';
import { z } from 'zod';
import { CloudAccountViewSchema } from '../services/cloud-account-view';
import { toDesktopOAuthLoginORPCError } from '../services/desktop-oauth-login.error';
import {
  DesktopOAuthLoginInputSchema,
  DesktopOAuthSessionCodeInputSchema,
  DesktopOAuthSessionInputSchema,
} from '../services/desktop-oauth-login.schema';
import { getCloudAccountAdapter } from './cloud-account-adapter';
import type { PreparedDesktopOAuthOperations } from './prepared-desktop-oauth';

async function runOAuthOperation<T>(
  operation: (session: PreparedDesktopOAuthOperations) => Promise<T>,
): Promise<T> {
  try {
    return await operation(await getCloudAccountAdapter().getOAuthSession());
  } catch (error) {
    throw toDesktopOAuthLoginORPCError(error);
  }
}

export const desktopOAuthSessionRouter = {
  prepare: os
    .input(DesktopOAuthLoginInputSchema)
    .output(DesktopOAuthSessionInputSchema)
    .handler(({ input }) => runOAuthOperation((session) => session.prepare(input.oauthClientKey))),
  open: os
    .input(DesktopOAuthSessionInputSchema)
    .output(z.void())
    .handler(({ input }) => runOAuthOperation((session) => session.open(input.sessionId))),
  copy: os
    .input(DesktopOAuthSessionInputSchema)
    .output(z.void())
    .handler(({ input }) => runOAuthOperation((session) => session.copy(input.sessionId))),
  wait: os
    .input(DesktopOAuthSessionInputSchema)
    .output(CloudAccountViewSchema)
    .handler(({ input }) => runOAuthOperation((session) => session.wait(input.sessionId))),
  submit: os
    .input(DesktopOAuthSessionCodeInputSchema)
    .output(z.void())
    .handler(({ input }) =>
      runOAuthOperation((session) => session.submit(input.sessionId, input.code)),
    ),
  cancel: os
    .input(DesktopOAuthSessionInputSchema)
    .output(z.void())
    .handler(({ input }) => runOAuthOperation((session) => session.cancel(input.sessionId))),
};
