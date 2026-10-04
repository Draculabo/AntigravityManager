import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { CloudAccountIdSchema } from '@/modules/cloud-account/services/cloud-account-mutation.schema';
import { normalizeTrustedGoogleValidationUrl } from '@/modules/cloud-account/utils/google-validation-url';
import type { AccountValidationLinkErrorCode } from './account-validation-link.schema';

export class AccountValidationLinkError extends Error {
  constructor(readonly validationCode: AccountValidationLinkErrorCode) {
    super('Account validation link is unavailable');
    this.name = 'AccountValidationLinkError';
  }
}

/** The trusted URL stays within the account owner and Electron main process. */
export async function resolveTrustedAccountValidationUrl(accountId: string): Promise<string> {
  if (!CloudAccountIdSchema.safeParse(accountId).success) {
    throw new AccountValidationLinkError('validation-link-failed');
  }
  let account;
  try {
    account = await CloudAccountRepo.getAccount(accountId);
  } catch {
    throw new AccountValidationLinkError('validation-link-failed');
  }
  if (!account) {
    throw new AccountValidationLinkError('account-not-found');
  }
  const url = normalizeTrustedGoogleValidationUrl(account.health?.validation?.verification_url);
  if (!url) {
    throw new AccountValidationLinkError('no-trusted-link');
  }
  return url;
}
