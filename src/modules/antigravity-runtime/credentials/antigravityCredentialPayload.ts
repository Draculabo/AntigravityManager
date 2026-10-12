import type { CredentialStoreTokenInput } from '@/shared/auth/credentialStoreToken';

/** Builds the credential payload shared by official desktop and CLI stores. */
export function buildAntigravityCredentialPayload(token: CredentialStoreTokenInput): string {
  const expiry = new Date(token.expiry_timestamp * 1000)
    .toISOString()
    .replace(/\.(\d{3})Z$/, '.$1000Z');
  return JSON.stringify({
    token: {
      access_token: token.access_token,
      token_type: 'Bearer',
      refresh_token: token.refresh_token,
      expiry,
      ...(token.id_token ? { id_token: token.id_token } : {}),
      ...(token.project_id ? { project_id: token.project_id } : {}),
    },
    auth_method: 'consumer',
  });
}
