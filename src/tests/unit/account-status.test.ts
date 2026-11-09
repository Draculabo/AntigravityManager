import { describe, expect, it } from 'vitest';
import { classifyAccountStatusFromError } from '@/modules/cloud-account/utils/account-status';

describe('classifyAccountStatusFromError', () => {
  it('does not treat a generic forbidden response as a rate limit', () => {
    expect(classifyAccountStatusFromError(new Error('HTTP 403: Forbidden'))).toBeNull();
  });

  it('still classifies explicit rate-limit signals', () => {
    expect(classifyAccountStatusFromError(new Error('HTTP 403: risk control active'))).toEqual({
      status: 'rate_limited',
      reason: 'HTTP 403: risk control active',
    });
  });

  it('still classifies unauthorized errors as expired credentials', () => {
    expect(classifyAccountStatusFromError(new Error('HTTP 401: Unauthorized'))).toEqual({
      status: 'expired',
      reason: 'HTTP 401: Unauthorized',
    });
  });

  it('classifies invalid_grant as requiring reauthentication', () => {
    expect(classifyAccountStatusFromError(new Error('{"error":"invalid_grant"}'))).toEqual({
      status: 'expired',
      reason: '{"error":"invalid_grant"}',
    });
  });

  it('classifies TOS_VIOLATION as expired with ToS reason', () => {
    expect(
      classifyAccountStatusFromError(
        new Error(
          'This service has been disabled in this account for violation of Terms of Service.',
        ),
      ),
    ).toEqual({
      status: 'expired',
      reason: 'This service has been disabled in this account for violation of Terms of Service.',
    });
  });

  it('classifies FORBIDDEN quota errors as expired', () => {
    expect(classifyAccountStatusFromError(new Error('FORBIDDEN'))).toEqual({
      status: 'expired',
      reason: 'FORBIDDEN',
    });
  });
});
