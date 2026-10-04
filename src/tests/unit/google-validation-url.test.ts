import { describe, expect, it } from 'vitest';

import { normalizeTrustedGoogleValidationUrl } from '@/modules/cloud-account/utils/google-validation-url';

describe('normalizeTrustedGoogleValidationUrl', () => {
  it.each(['https://accounts.google.com/verify?id=1'])(
    'accepts trusted Google HTTPS URL %s',
    (url) => {
      expect(normalizeTrustedGoogleValidationUrl(url)).toBe(url);
    },
  );

  it.each([
    'http://accounts.google.com/verify',
    'https://google.com.evil.example/verify',
    'https://evilgoogle.com/verify',
    'https://google.com@evil.example/verify',
    'https://google.com/verify',
    'https://support.google.com/accounts/answer/1',
    'https://sites.google.com/view/untrusted',
    'https://user:password@accounts.google.com/verify',
    'https://accounts.google.com:4443/verify',
    `https://accounts.google.com/verify?state=${'x'.repeat(2048)}`,
    'not-a-url',
  ])('rejects untrusted validation URL %s', (url) => {
    expect(normalizeTrustedGoogleValidationUrl(url)).toBeUndefined();
  });
});
