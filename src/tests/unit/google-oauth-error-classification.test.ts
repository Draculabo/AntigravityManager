import { describe, expect, it } from 'vitest';
import { isClientMismatchError } from '@/modules/cloud-account/services/GoogleAPIService';

describe('Google OAuth client error classification', () => {
  it.each([
    ['invalid_client', '{"error":"invalid_client"}'],
    ['unauthorized_client', '{"error":"unauthorized_client"}'],
    ['deleted_client', '{"error":"deleted_client"}'],
    ['plain text invalid_client', 'OAuth error: invalid_client'],
  ])('retries another OAuth client for %s', (_label, responseBody) => {
    expect(isClientMismatchError(responseBody)).toBe(true);
  });

  it.each([
    [
      'invalid_grant',
      '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}',
    ],
    ['invalid_request', '{"error":"invalid_request"}'],
    ['access_denied', '{"error":"access_denied"}'],
    ['org_internal', '{"error":"org_internal"}'],
    ['generic bad request', 'Bad Request'],
    ['generic forbidden', 'Forbidden'],
  ])('does not rotate OAuth clients for %s', (_label, responseBody) => {
    expect(isClientMismatchError(responseBody)).toBe(false);
  });
});
