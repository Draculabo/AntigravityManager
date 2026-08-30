import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { CredentialStoreTokenInput } from '@/shared/auth/credentialStoreToken';
import { GOOGLE_OAUTH_SCOPE } from '../oauthScopes';
import { writePrivateFileAtomically } from './privateCredentialFile';

const GoogleAccountsFileSchema = z.object({
  active: z.string().nullable(),
  old: z.array(z.string()),
});

export interface GoogleOAuthCredentialInput extends CredentialStoreTokenInput {
  email: string;
}

export interface GoogleOAuthCredentialStoreOptions {
  geminiDir?: string;
}

/**
 * Synchronizes the generic Gemini CLI OAuth cache for an explicit Agy switch.
 * `google_accounts.json` is written last so its active email marks the token
 * file that was successfully installed immediately before it.
 */
export function writeGoogleOAuthCredentials(
  input: GoogleOAuthCredentialInput,
  options: GoogleOAuthCredentialStoreOptions = {},
): void {
  const geminiDir = options.geminiDir ?? path.join(os.homedir(), '.gemini');
  const oauthPath = path.join(geminiDir, 'oauth_creds.json');
  const accountsPath = path.join(geminiDir, 'google_accounts.json');
  const accounts = readGoogleAccountsFile(accountsPath);
  const nextAccounts = buildNextGoogleAccounts(accounts, input.email);

  const oauthPayload = JSON.stringify(
    {
      access_token: input.access_token,
      refresh_token: input.refresh_token,
      token_type: 'Bearer',
      expiry_date: input.expiry_timestamp * 1000,
      ...(input.id_token ? { id_token: input.id_token } : {}),
      scope: GOOGLE_OAUTH_SCOPE,
    },
    null,
    2,
  );
  const accountsPayload = JSON.stringify(nextAccounts, null, 2);

  writePrivateFileAtomically(oauthPath, oauthPayload);
  writePrivateFileAtomically(accountsPath, accountsPayload);
}

function readGoogleAccountsFile(accountsPath: string): z.infer<typeof GoogleAccountsFileSchema> {
  if (!fs.existsSync(accountsPath)) {
    return { active: null, old: [] };
  }

  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(accountsPath, 'utf-8'));
    return GoogleAccountsFileSchema.parse(parsed);
  } catch {
    throw new Error(
      'Existing google_accounts.json is malformed; credential files were not changed',
    );
  }
}

function buildNextGoogleAccounts(
  current: z.infer<typeof GoogleAccountsFileSchema>,
  email: string,
): z.infer<typeof GoogleAccountsFileSchema> {
  const old = current.old.filter((candidate) => candidate !== email);
  if (current.active && current.active !== email && !old.includes(current.active)) {
    old.push(current.active);
  }

  return {
    active: email,
    old,
  };
}
