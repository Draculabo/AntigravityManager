import { shell } from 'electron';
import { AccountValidationLinkError } from '@/modules/cloud-account/services/account-validation-link.service';
import { TrustedGoogleValidationUrlSchema } from '@/modules/cloud-account/services/account-validation-link.schema';

/** Revalidate core output before passing it to the operating system. */
export async function openTrustedAccountValidationUrl(value: string): Promise<void> {
  const parsed = TrustedGoogleValidationUrlSchema.safeParse(value);
  if (!parsed.success) {
    throw new AccountValidationLinkError('validation-link-failed');
  }
  try {
    await shell.openExternal(parsed.data);
  } catch {
    throw new AccountValidationLinkError('validation-link-failed');
  }
}
