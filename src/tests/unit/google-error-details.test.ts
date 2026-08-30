import { describe, expect, it } from 'vitest';

import {
  classifyForbiddenUpstreamError,
  extractGoogleErrorDetails,
} from '@/modules/proxy-gateway/server/common/google-error-details';
import { UpstreamRequestError } from '@/modules/proxy-gateway/server/common/exceptions/upstream-request.exception';

const VALIDATION_PAYLOAD = {
  error: {
    code: 403,
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        domain: 'cloudcode-pa.googleapis.com',
        metadata: { validation_link: 'https://example.com/verify' },
        reason: 'VALIDATION_REQUIRED',
      },
      {
        '@type': 'type.googleapis.com/google.rpc.Help',
        links: [
          { description: 'Verify your account', url: 'https://example.com/verify' },
          { description: 'Learn more', url: 'https://support.google.com/help' },
        ],
      },
    ],
    message: 'Permission denied',
    status: 'PERMISSION_DENIED',
  },
};

describe('google error details', () => {
  it('reads the structured details out of an upstream payload', () => {
    const details = extractGoogleErrorDetails(VALIDATION_PAYLOAD);

    expect(details).toEqual([
      expect.objectContaining({
        domain: 'cloudcode-pa.googleapis.com',
        reason: 'VALIDATION_REQUIRED',
        type: 'type.googleapis.com/google.rpc.ErrorInfo',
      }),
      expect.objectContaining({ type: 'type.googleapis.com/google.rpc.Help' }),
    ]);
  });

  it('reads them out of the payload in its serialized form too', () => {
    expect(extractGoogleErrorDetails(JSON.stringify(VALIDATION_PAYLOAD))).toEqual(
      extractGoogleErrorDetails(VALIDATION_PAYLOAD),
    );
  });

  it('names the verification link a recoverable 403 carries', () => {
    expect(
      classifyForbiddenUpstreamError({ details: extractGoogleErrorDetails(VALIDATION_PAYLOAD) }),
    ).toMatchObject({
      kind: 'validation_required',
      learnMoreUrl: 'https://support.google.com/help',
      validationLink: 'https://example.com/verify',
    });
  });

  it('survives the body truncation that made the field necessary', () => {
    const error = new UpstreamRequestError({
      body: JSON.stringify(VALIDATION_PAYLOAD).padEnd(4000, ' '),
      details: extractGoogleErrorDetails(VALIDATION_PAYLOAD),
      message: 'Permission denied',
      status: 403,
    });

    expect(error.body?.length).toBe(1000);
    expect(classifyForbiddenUpstreamError({ details: error.details })).toMatchObject({
      kind: 'validation_required',
    });
  });

  it.each([
    ['Gemini Code Assist is not currently available in your location.', 'location_ineligible'],
    [
      'You are currently configured to use a Google Cloud Project but lack a Gemini Code Assist license. (#3501)',
      'license_required',
    ],
  ] as const)('classifies durable provider eligibility failures: %s', (message, kind) => {
    expect(classifyForbiddenUpstreamError({ message })).toEqual({ kind });
  });

  it.each([
    'Another product is not available in your location.',
    'The account has an unrelated software license problem.',
  ])('does not broaden eligibility matching to unrelated errors: %s', (message) => {
    expect(classifyForbiddenUpstreamError({ message })).toEqual({ kind: 'account_forbidden' });
  });

  it('calls anything it does not recognise a dead account', () => {
    expect(
      classifyForbiddenUpstreamError({
        body: '{"error":{"status":"PERMISSION_DENIED"}}',
        message: 'The caller does not have permission',
      }),
    ).toEqual({ kind: 'account_forbidden' });
    expect(classifyForbiddenUpstreamError({})).toEqual({ kind: 'account_forbidden' });
    expect(
      classifyForbiddenUpstreamError({
        details: [{ domain: 'example.googleapis.com', reason: 'VALIDATION_REQUIRED' }],
      }),
    ).toEqual({ kind: 'account_forbidden' });
  });

  it('drops a link that is not a plain http url', () => {
    const details = extractGoogleErrorDetails({
      error: {
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.Help',
            links: [{ description: 'Verify', url: 'javascript:alert(1)' }],
          },
        ],
      },
    });

    expect(details?.[0]?.links?.[0]?.url).toBeUndefined();
  });
});
