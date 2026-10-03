import type { CredentialStoreTokenInput } from '@/shared/auth/credentialStoreToken';

export interface ClientAccountCredentials {
  email: string;
  name: string;
  token: CredentialStoreTokenInput & {
    project_id?: string;
    is_gcp_tos?: boolean;
    oauth_client_key?: string;
  };
}

/** Detaches the credentials that will be reasserted throughout one switch. */
export function prepareClientAccountCredentials(
  input: ClientAccountCredentials,
): ClientAccountCredentials {
  const credentials = structuredClone(input);
  credentials.email = credentials.email.trim();
  credentials.token.access_token = credentials.token.access_token.trim();
  credentials.token.refresh_token = credentials.token.refresh_token.trim();
  credentials.token.id_token = credentials.token.id_token?.trim() || undefined;
  credentials.token.project_id = credentials.token.project_id?.trim() || undefined;
  if (!credentials.email || !credentials.token.access_token.trim()) {
    throw new Error('Selected account has no usable identity or access token');
  }
  if (
    !Number.isSafeInteger(credentials.token.expiry_timestamp) ||
    credentials.token.expiry_timestamp <= 0 ||
    credentials.token.expiry_timestamp > 10_000_000_000
  ) {
    throw new Error('Selected account has an invalid token expiry');
  }
  if (
    !credentials.token.refresh_token.trim() &&
    credentials.token.expiry_timestamp <= Math.floor(Date.now() / 1000)
  ) {
    throw new Error(
      'Selected account has an expired token without a refresh token. Please re-login.',
    );
  }
  return credentials;
}
