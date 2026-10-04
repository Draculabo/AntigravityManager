import { os } from '@orpc/server';
import { z } from 'zod';
import { openIdentityStorageFolder } from './handler';
import { getLocalAccountAdapter } from './local-account-adapter';
import { createLocalAccountRouter } from '../services/local-account.router';
import type { LocalAccountOperations } from '../services/local-account-owner.service';

const selectedOwner: LocalAccountOperations = {
  listAccounts: () => getLocalAccountAdapter().listAccounts(),
  addAccountSnapshot: (target) => getLocalAccountAdapter().addAccountSnapshot(target),
  getCurrentAccountInfo: (target) => getLocalAccountAdapter().getCurrentAccountInfo(target),
  switchAccount: (id, target) => getLocalAccountAdapter().switchAccount(id, target),
  deleteAccount: (id) => getLocalAccountAdapter().deleteAccount(id),
  previewGenerateIdentityProfile: () => getLocalAccountAdapter().previewGenerateIdentityProfile(),
  getIdentityProfiles: (id) => getLocalAccountAdapter().getIdentityProfiles(id),
  bindIdentityProfile: (id, mode) => getLocalAccountAdapter().bindIdentityProfile(id, mode),
  bindIdentityProfileWithPayload: (id, profile) =>
    getLocalAccountAdapter().bindIdentityProfileWithPayload(id, profile),
  applyBoundIdentityProfile: (id) => getLocalAccountAdapter().applyBoundIdentityProfile(id),
  restoreIdentityProfileRevision: (id, revision) =>
    getLocalAccountAdapter().restoreIdentityProfileRevision(id, revision),
  deleteIdentityProfileRevision: (id, revision) =>
    getLocalAccountAdapter().deleteIdentityProfileRevision(id, revision),
  restoreBaselineProfile: (id) => getLocalAccountAdapter().restoreBaselineProfile(id),
};
const ownerRouter = createLocalAccountRouter(selectedOwner);
export const accountRouter = os.router({
  ...ownerRouter,
  openIdentityStorageFolder: os.output(z.void()).handler(openIdentityStorageFolder),
});
// Raw backup/restore transport had no production consumer; credentials stay in owner policy.
export const databaseRouter = os.router({
  getCurrentAccountInfo: ownerRouter.getCurrentAccountInfo,
});
