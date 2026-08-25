import { describe, expect, it, vi } from 'vitest';
import { ProxyRetryService } from '@/modules/proxy-gateway/server/shared/services/proxy-retry.service';
import { UpstreamRequestError } from '@/modules/proxy-gateway/server/common/exceptions/upstream-request.exception';
import { proxyModelAvailabilityStore } from '@/modules/proxy-gateway/server/shared/services/model-availability.service';
import type { CloudAccount } from '@/modules/cloud-account/types';

function createToken(id: string): CloudAccount {
  return {
    id,
    provider: 'google',
    email: `${id}@example.com`,
    token: {
      access_token: `access-${id}`,
      refresh_token: `refresh-${id}`,
      token_type: 'Bearer',
      expires_in: 3600,
      expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
    },
    created_at: 1,
    last_used: 1,
  };
}

function createPolicy() {
  const accountLeaseService = {
    getNextToken: vi.fn(),
    recordParityError: vi.fn(),
    markAsForbidden: vi.fn(),
    markAsRateLimited: vi.fn(),
    markFromUpstreamError: vi.fn().mockResolvedValue(undefined),
    getRemainingRateLimitWait: vi.fn().mockReturnValue(30),
    markModelSuccess: vi.fn(),
  };
  const logger = {
    log: vi.fn(),
    warn: vi.fn(),
  };
  const policy = new ProxyRetryService(accountLeaseService, logger, proxyModelAvailabilityStore);

  return {
    logger,
    policy,
    accountLeaseService,
  };
}

describe('ProxyRetryService', () => {
  it('classifies retryable upstream failures consistently', () => {
    const { policy } = createPolicy();

    expect(policy.classifyUpstreamFailure('403 permission_denied')).toEqual({
      retry: true,
      markAsForbidden: true,
      markAsRateLimited: false,
    });
    expect(policy.classifyUpstreamFailure('429 quota exceeded')).toEqual({
      retry: true,
      markAsForbidden: false,
      markAsRateLimited: true,
    });
    expect(policy.classifyUpstreamFailure('socket hang up')).toEqual({
      retry: true,
      markAsForbidden: false,
      markAsRateLimited: false,
    });
    expect(policy.classifyUpstreamFailure('bad user request')).toEqual({
      retry: false,
      markAsForbidden: false,
      markAsRateLimited: false,
    });
  });

  it('selects retry tokens while excluding already attempted accounts', async () => {
    const { policy, accountLeaseService } = createPolicy();
    const retryState = policy.createTokenRetryState();

    accountLeaseService.getNextToken.mockResolvedValueOnce(createToken('acc-1'));
    accountLeaseService.getNextToken.mockResolvedValueOnce(createToken('acc-2'));

    await expect(
      policy.selectRetryToken(retryState, 'gemini-3-flash', 'session-1'),
    ).resolves.toEqual(expect.objectContaining({ id: 'acc-1' }));
    await expect(
      policy.selectRetryToken(retryState, 'gemini-3-flash', 'session-1'),
    ).resolves.toEqual(expect.objectContaining({ id: 'acc-2' }));

    expect(accountLeaseService.getNextToken).toHaveBeenNthCalledWith(1, {
      sessionKey: 'session-1',
      excludeAccountIds: [],
      model: 'gemini-3-flash',
    });
    expect(accountLeaseService.getNextToken).toHaveBeenNthCalledWith(2, {
      sessionKey: 'session-1',
      excludeAccountIds: ['acc-1'],
      model: 'gemini-3-flash',
    });
  });

  it('routes structured upstream errors to account lease upstream error handling', async () => {
    const { policy, accountLeaseService } = createPolicy();

    await policy.applyUpstreamPenalty(
      'acc-1',
      'gemini-3-flash',
      new UpstreamRequestError({
        message: 'quota exhausted',
        status: 429,
        headers: { retryAfter: '30' },
        body: 'quota exhausted',
      }),
    );

    expect(accountLeaseService.recordParityError).toHaveBeenCalledOnce();
    expect(accountLeaseService.markFromUpstreamError).toHaveBeenCalledWith({
      accountIdOrEmail: 'acc-1',
      status: 429,
      retryAfter: '30',
      body: 'quota exhausted',
      model: 'gemini-3-flash',
    });
  });

  it('persists the tracker-clamped wait instead of the raw upstream retry delay', async () => {
    proxyModelAvailabilityStore.clearAccount('acc-clamped');
    const { policy, accountLeaseService } = createPolicy();
    accountLeaseService.getRemainingRateLimitWait.mockReturnValue(300);
    const startedAt = Date.now();

    await policy.applyUpstreamPenalty(
      'acc-clamped',
      'gemini-3.1-pro-high',
      new UpstreamRequestError({
        message: 'quota exhausted',
        status: 429,
        headers: { retryAfter: '3600' },
        body: 'quota_exhausted',
      }),
    );

    const entry = proxyModelAvailabilityStore
      .getSnapshot()
      .find((candidate) => candidate.accountId === 'acc-clamped');
    expect(accountLeaseService.markFromUpstreamError).toHaveBeenCalledBefore(
      accountLeaseService.getRemainingRateLimitWait,
    );
    expect(entry).toEqual(
      expect.objectContaining({
        accountId: 'acc-clamped',
        modelId: 'gemini-3.1-pro-high',
        reason: 'quota_exhausted',
      }),
    );
    expect(entry?.unavailableUntil).toBeGreaterThanOrEqual(startedAt + 300_000);
    expect(entry?.unavailableUntil).toBeLessThanOrEqual(Date.now() + 300_000);
    proxyModelAvailabilityStore.clearAccount('acc-clamped');
  });

  it('classifies generic RESOURCE_EXHAUSTED availability as a transient rate limit', async () => {
    proxyModelAvailabilityStore.clearAccount('acc-resource');
    const { policy } = createPolicy();

    await policy.applyUpstreamPenalty(
      'acc-resource',
      'gemini-3.1-pro-high',
      new UpstreamRequestError({
        message: 'Resource has been exhausted',
        status: 429,
        body: JSON.stringify({
          error: {
            message: 'Resource has been exhausted (e.g. check quota).',
            status: 'RESOURCE_EXHAUSTED',
          },
        }),
      }),
    );

    expect(proxyModelAvailabilityStore.getSnapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: 'acc-resource',
          modelId: 'gemini-3.1-pro-high',
          reason: 'rate_limited',
        }),
      ]),
    );
    proxyModelAvailabilityStore.clearAccount('acc-resource');
  });

  it('clears model-scoped retry state after a successful upstream request', () => {
    proxyModelAvailabilityStore.clearAccount('acc-success');
    proxyModelAvailabilityStore.mark('acc-success', 'gemini-3.1-pro-high', 'rate_limited');
    const { policy, accountLeaseService } = createPolicy();

    policy.markUpstreamSuccess('acc-success', 'gemini-3.1-pro-high');

    expect(accountLeaseService.markModelSuccess).toHaveBeenCalledWith(
      'acc-success',
      'gemini-3.1-pro-high',
    );
    expect(proxyModelAvailabilityStore.getSnapshot()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: 'acc-success',
          modelId: 'gemini-3.1-pro-high',
        }),
      ]),
    );
  });

  it.each([
    [404, 'model_not_supported'],
    [403, 'model_forbidden'],
  ] as const)(
    'keeps image-model %i failures scoped to the affected model',
    async (status, reason) => {
      proxyModelAvailabilityStore.clearAccount('acc-image');
      const { policy, accountLeaseService } = createPolicy();

      await policy.applyUpstreamPenalty(
        'acc-image',
        'gemini-3-pro-image',
        new UpstreamRequestError({
          message: `image request failed with ${status}`,
          status,
        }),
      );

      expect(accountLeaseService.markAsForbidden).not.toHaveBeenCalled();
      expect(accountLeaseService.markFromUpstreamError).not.toHaveBeenCalled();
      expect(proxyModelAvailabilityStore.getSnapshot()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            accountId: 'acc-image',
            modelId: 'gemini-3-pro-image',
            reason,
          }),
        ]),
      );
      proxyModelAvailabilityStore.clearAccount('acc-image');
    },
  );

  it('marks string-classified rate limits on generic errors', async () => {
    const { policy, accountLeaseService } = createPolicy();

    await policy.applyUpstreamPenalty('acc-1', 'gemini-3-flash', new Error('429 quota exceeded'));

    expect(accountLeaseService.recordParityError).toHaveBeenCalledOnce();
    expect(accountLeaseService.markAsRateLimited).not.toHaveBeenCalled();
    expect(accountLeaseService.markFromUpstreamError).toHaveBeenCalledWith({
      accountIdOrEmail: 'acc-1',
      status: 429,
      body: '429 quota exceeded',
      model: 'gemini-3-flash',
    });
  });
  it('keeps the account in rotation for a VALIDATION_REQUIRED 403', async () => {
    const { policy, accountLeaseService } = createPolicy();

    await policy.applyUpstreamPenalty(
      'acc-validation',
      'gemini-3-flash',
      new UpstreamRequestError({
        message: 'Permission denied',
        status: 403,
        details: [
          {
            type: 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'VALIDATION_REQUIRED',
            domain: 'cloudcode-pa.googleapis.com',
          },
          {
            type: 'type.googleapis.com/google.rpc.Help',
            links: [{ description: 'Verify your account', url: 'https://example.com/verify' }],
          },
        ],
      }),
    );

    expect(accountLeaseService.markAsForbidden).not.toHaveBeenCalled();
    expect(accountLeaseService.markFromUpstreamError).not.toHaveBeenCalled();
  });

  it('keeps the account in rotation for a SECURITY_POLICY_VIOLATED 403', async () => {
    const { policy, accountLeaseService } = createPolicy();

    await policy.applyUpstreamPenalty(
      'acc-vpcsc',
      'gemini-3-flash',
      new UpstreamRequestError({
        message: 'Request is prohibited by organization policy',
        status: 403,
        details: [{ reason: 'SECURITY_POLICY_VIOLATED' }],
      }),
    );

    expect(accountLeaseService.markAsForbidden).not.toHaveBeenCalled();
    expect(accountLeaseService.markFromUpstreamError).not.toHaveBeenCalled();
  });

  it('recognises a recoverable 403 from a truncated body alone', async () => {
    const { policy, accountLeaseService } = createPolicy();

    await policy.applyUpstreamPenalty(
      'acc-body',
      'gemini-3-flash',
      new UpstreamRequestError({
        message: 'Permission denied',
        status: 403,
        body: '{"error":{"details":[{"reason":"VALIDATION_REQUIRED","domain":"cloudcode-pa.googleapis.com"',
      }),
    );

    expect(accountLeaseService.markAsForbidden).not.toHaveBeenCalled();
  });

  it('still burns the account on a 403 that names no recoverable condition', async () => {
    const { policy, accountLeaseService } = createPolicy();

    await policy.applyUpstreamPenalty(
      'acc-dead',
      'gemini-3-flash',
      new UpstreamRequestError({
        message: 'The caller does not have permission',
        status: 403,
        body: '{"error":{"status":"PERMISSION_DENIED"}}',
      }),
    );

    expect(accountLeaseService.markAsForbidden).toHaveBeenCalledWith('acc-dead');
  });

  it('still burns the account on a 401', async () => {
    const { policy, accountLeaseService } = createPolicy();

    await policy.applyUpstreamPenalty(
      'acc-401',
      'gemini-3-flash',
      new UpstreamRequestError({
        message: 'Invalid credentials',
        status: 401,
        details: [{ reason: 'VALIDATION_REQUIRED', domain: 'cloudcode-pa.googleapis.com' }],
      }),
    );

    expect(accountLeaseService.markAsForbidden).toHaveBeenCalledWith('acc-401');
  });

  it('does not mistake a VALIDATION_REQUIRED 403 from another domain for a recoverable one', async () => {
    const { policy, accountLeaseService } = createPolicy();

    await policy.applyUpstreamPenalty(
      'acc-other-domain',
      'gemini-3-flash',
      new UpstreamRequestError({
        message: 'Permission denied',
        status: 403,
        details: [{ reason: 'VALIDATION_REQUIRED', domain: 'example.googleapis.com' }],
      }),
    );

    expect(accountLeaseService.markAsForbidden).toHaveBeenCalledWith('acc-other-domain');
  });
});
