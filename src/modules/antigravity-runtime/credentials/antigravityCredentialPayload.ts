import type { CredentialStoreTokenInput } from '@/shared/auth/credentialStoreToken';
import type { ClientAccountCredentials } from './clientAccount';

function buildOAuthToken(token: CredentialStoreTokenInput) {
  const expiry = new Date(token.expiry_timestamp * 1000)
    .toISOString()
    .replace(/\.(\d{3})Z$/, '.$1000Z');
  return {
    access_token: token.access_token,
    token_type: 'Bearer',
    refresh_token: token.refresh_token,
    expiry,
  };
}

/** Builds the credential payload shared by official desktop and CLI stores. */
export function buildAntigravityCredentialPayload(token: CredentialStoreTokenInput): string {
  return JSON.stringify({
    token: {
      ...buildOAuthToken(token),
      ...(token.id_token ? { id_token: token.id_token } : {}),
      ...(token.project_id ? { project_id: token.project_id } : {}),
    },
    auth_method: 'consumer',
  });
}

/** Windows IDE 2.6+ Agent identity fields belong to the credential envelope. */
export function buildWindowsIdeCredentialPayload(credentials: ClientAccountCredentials): string {
  const { email, token } = credentials;
  return JSON.stringify({
    token: {
      ...buildOAuthToken(token),
      expires_in: 3599,
      ...(token.project_id ? { project_id: token.project_id } : {}),
    },
    auth_method: 'consumer',
    id_token_email: email,
    ...(token.id_token ? { id_token: token.id_token } : {}),
  });
}
