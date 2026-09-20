import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ProxyRetryService } from '@/modules/proxy-gateway/server/shared/services/proxy-retry.service';
import { UpstreamRequestError } from '@/modules/proxy-gateway/server/common/exceptions/upstream-request.exception';
import { proxyModelAvailabilityStore } from '@/modules/proxy-gateway/server/shared/services/model-availability.service';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { ProxyAccountUnavailableError } from '@/modules/proxy-gateway/server/common/exceptions/proxy-account-unavailable.exception';

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
    getNextImageToken: vi.fn(),
    recordParityError: vi.fn(),
    markAsForbidden: vi.fn(),
    markAsRateLimited: vi.fn(),
    markFromUpstreamError: vi.fn().mockResolvedValue(undefined),
    getRemainingRateLimitWait: vi.fn().mockReturnValue(30),
    getMinimumRateLimitWaitForPool: vi.fn().mockReturnValue(undefined),
    markModelSuccess: vi.fn(),
    markValidationRequired: vi.fn().mockResolvedValue(undefined),
    markImageRateLimitFast: vi.fn().mockReturnValue(false),
    reconcileImageRateLimit: vi.fn().mockResolvedValue(undefined),
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

  it('reports an initially unavailable account pool as 503 with its shortest wait', async () => {
    const { policy, accountLeaseService } = createPolicy();
    const retryState = policy.createTokenRetryState();
    accountLeaseService.getNextToken.mockResolvedValue(null);
    accountLeaseService.getMinimumRateLimitWaitForPool.mockReturnValue(17);

    await expect(policy.selectRetryToken(retryState, 'gemini-3-flash')).rejects.toMatchObject({
      retryAfterSeconds: 17,
    });

    try {
      await policy.selectRetryToken(policy.createTokenRetryState(), 'gemini-3-flash');
    } catch (error) {
      expect(error).toBeInstanceOf(ProxyAccountUnavailableError);
      expect((error as ProxyAccountUnavailableError).getStatus()).toBe(503);
    }
  });

  it('preserves the shortest wait when the image account pool is unavailable', async () => {
    const { policy, accountLeaseService } = createPolicy();
    accountLeaseService.getNextImageToken.mockRejectedValue(
      new HttpException('No available image accounts', 503),
    );
    accountLeaseService.getMinimumRateLimitWaitForPool.mockReturnValue(11);

    await expect(
      policy.selectRetryToken(
        policy.createTokenRetryState(),
        'gemini-3.1-flash-image',
        undefined,
        true,
      ),
    ).rejects.toMatchObject({
      retryAfterSeconds: 11,
    });
  });

  it('keeps one image permit across grace and releases it before reconciliation on rotation', async () => {
    vi.useFakeTimers();
    try {
      const { policy, accountLeaseService } = createPolicy();
      const retryState = policy.createTokenRetryState();
      const token = createToken('acc-1');
      const order: string[] = [];
      const permit = { release: vi.fn(() => order.push('release')) };
      accountLeaseService.getNextImageToken.mockResolvedValue({ token, permit });
      accountLeaseService.markImageRateLimitFast
        .mockImplementationOnce(() => {
          order.push('fast');
          return false;
        })
        .mockImplementationOnce(() => {
          order.push('fast');
          return true;
        });
      accountLeaseService.reconcileImageRateLimit.mockImplementation(async () => {
        order.push('reconcile');
      });

      await expect(
        policy.selectRetryToken(retryState, 'gemini-3.1-flash-image', 'session-1', true),
      ).resolves.toBe(token);

      const shortLimit = new UpstreamRequestError({
        message: 'rate limited',
        status: 429,
        body: JSON.stringify({ error: { details: [{ retryDelay: '1ms' }] } }),
      });
      const grace = policy.prepareScheduledImageRetry(
        retryState,
        token,
        'gemini-3.1-flash-image',
        shortLimit,
        'image',
      );
      await vi.runAllTimersAsync();
      await expect(grace).resolves.toBe(true);
      expect(permit.release).not.toHaveBeenCalled();

      await expect(
        policy.selectRetryToken(retryState, 'gemini-3.1-flash-image', 'session-1', true),
      ).resolves.toBe(token);
      const hardLimit = new UpstreamRequestError({
        message: 'quota exhausted',
        status: 429,
        body: 'QUOTA_EXHAUSTED',
      });
      await expect(
        policy.prepareScheduledImageRetry(
          retryState,
          token,
          'gemini-3.1-flash-image',
          hardLimit,
          'image',
        ),
      ).resolves.toBe(false);

      expect(order).toEqual(['fast', 'fast', 'release', 'reconcile']);
      expect(permit.release).toHaveBeenCalledTimes(1);
      expect(accountLeaseService.recordParityError).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases an image permit when the request is aborted during grace wait', async () => {
    const { policy, accountLeaseService } = createPolicy();
    const retryState = policy.createTokenRetryState();
    const token = createToken('acc-abort');
    const permit = { release: vi.fn() };
    accountLeaseService.getNextImageToken.mockResolvedValue({ token, permit });
    await policy.selectRetryToken(retryState, 'gemini-3.1-flash-image', undefined, true);
    const error = new UpstreamRequestError({
      message: 'rate limited',
      status: 429,
      body: JSON.stringify({ error: { details: [{ retryDelay: '1s' }] } }),
    });
    const controller = new AbortController();
    const retry = policy.prepareScheduledImageRetry(
      retryState,
      token,
      'gemini-3.1-flash-image',
      error,
      'image',
      true,
      controller.signal,
    );
    controller.abort();

    await expect(retry).rejects.toMatchObject({ name: 'AbortError' });
    expect(permit.release).toHaveBeenCalledTimes(1);
  });

  it('releases an image permit when slow rate-limit reconciliation fails', async () => {
    const { policy, accountLeaseService } = createPolicy();
    const retryState = policy.createTokenRetryState();
    const token = createToken('acc-reconcile-error');
    const permit = { release: vi.fn() };
    accountLeaseService.getNextImageToken.mockResolvedValue({ token, permit });
    accountLeaseService.markImageRateLimitFast.mockReturnValue(true);
    accountLeaseService.reconcileImageRateLimit.mockRejectedValue(new Error('refresh failed'));
    await policy.selectRetryToken(retryState, 'gemini-3.1-flash-image', undefined, true);

    await expect(
      policy.prepareScheduledImageRetry(
        retryState,
        token,
        'gemini-3.1-flash-image',
        new UpstreamRequestError({
          message: 'quota exhausted',
          status: 429,
          body: 'QUOTA_EXHAUSTED',
        }),
        'image',
      ),
    ).rejects.toThrow('refresh failed');
    expect(permit.release).toHaveBeenCalledTimes(1);
  });

  it('fast-marks OpenAI image 500/503/529 failures before releasing their permits', async () => {
    for (const status of [500, 503, 529]) {
      const { policy, accountLeaseService } = createPolicy();
      const retryState = policy.createTokenRetryState();
      const token = createToken(`acc-${status}`);
      const order: string[] = [];
      const permit = { release: vi.fn(() => order.push('release')) };
      accountLeaseService.getNextImageToken.mockResolvedValue({ token, permit });
      accountLeaseService.markImageRateLimitFast.mockImplementation(() => {
        order.push('fast');
        return false;
      });
      await policy.selectRetryToken(retryState, 'gemini-3.1-flash-image', undefined, true);

      await expect(
        policy.prepareScheduledImageRetry(
          retryState,
          token,
          'gemini-3.1-flash-image',
          new UpstreamRequestError({ message: 'server busy', status }),
          'image',
          true,
          undefined,
          'openai',
        ),
      ).resolves.toBe(false);

      expect(order).toEqual(['fast', 'release']);
      expect(accountLeaseService.markFromUpstreamError).not.toHaveBeenCalled();
      expect(accountLeaseService.reconcileImageRateLimit).not.toHaveBeenCalled();
    }
  });

  it('reuses each account once without consuming the account-rotation budget', async () => {
    vi.useFakeTimers();
    try {
      const { policy, accountLeaseService } = createPolicy();
      const retryState = policy.createTokenRetryState();
      const first = createToken('acc-1');
      const second = createToken('acc-2');
      accountLeaseService.getNextToken.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
      const short429 = new UpstreamRequestError({
        message: 'rate limited',
        status: 429,
        body: JSON.stringify({ error: { details: [{ retryDelay: '1ms' }] } }),
      });

      const sequence: string[] = [];
      sequence.push((await policy.selectRetryToken(retryState, 'gemini-3-pro-image'))?.id ?? '');
      const firstGrace = policy.prepareGraceRetry(retryState, first, short429, 'image');
      await vi.runAllTimersAsync();
      await expect(firstGrace).resolves.toBe(true);
      sequence.push((await policy.selectRetryToken(retryState, 'gemini-3-pro-image'))?.id ?? '');
      await expect(policy.prepareGraceRetry(retryState, first, short429, 'image')).resolves.toBe(
        false,
      );
      sequence.push((await policy.selectRetryToken(retryState, 'gemini-3-pro-image'))?.id ?? '');
      const secondGrace = policy.prepareGraceRetry(retryState, second, short429, 'image');
      await vi.runAllTimersAsync();
      await expect(secondGrace).resolves.toBe(true);
      sequence.push((await policy.selectRetryToken(retryState, 'gemini-3-pro-image'))?.id ?? '');

      expect(sequence).toEqual(['acc-1', 'acc-1', 'acc-2', 'acc-2']);
      expect(accountLeaseService.getNextToken).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses source-specific grace buffers and refuses hard quota grace retries', () => {
    const { policy } = createPolicy();
    const structured = new UpstreamRequestError({
      message: 'rate limited',
      status: 429,
      body: JSON.stringify({ error: { details: [{ retryDelay: '1s' }] } }),
    });
    const header = new UpstreamRequestError({
      message: 'rate limited',
      status: 429,
      headers: { retryAfter: '3' },
    });
    const text = new UpstreamRequestError({
      message: 'retry after 3s',
      status: 429,
      body: 'retry after 3s',
    });
    const hardQuota = new UpstreamRequestError({
      message: 'QUOTA_EXHAUSTED',
      status: 429,
      body: 'QUOTA_EXHAUSTED; retry after 1s',
    });
    const quotaResetMetadata = new UpstreamRequestError({
      message: 'rate limited',
      status: 429,
      body: JSON.stringify({ error: { details: [{ metadata: { quotaResetDelay: '1s' } }] } }),
    });

    expect(policy.resolveGraceRetryDelay(structured)).toBe(1200);
    expect(policy.resolveGraceRetryDelay(header)).toBe(3200);
    expect(policy.resolveGraceRetryDelay(text)).toBe(4000);
    expect(policy.resolveGraceRetryDelay(quotaResetMetadata)).toBe(1200);
    expect(policy.resolveGraceRetryDelay(hardQuota)).toBeNull();
  });

  it('keeps the baseline Anthropic grace window at two seconds', () => {
    const { policy } = createPolicy();
    const twoSeconds = new UpstreamRequestError({
      message: 'retry after 2s',
      status: 429,
      body: 'retry after 2s',
    });
    const threeSeconds = new UpstreamRequestError({
      message: 'retry after 3s',
      status: 429,
      body: 'retry after 3s',
    });

    expect(policy.resolveBaselineGraceRetryDelay(twoSeconds)).toBe(3500);
    expect(policy.resolveBaselineGraceRetryDelay(threeSeconds)).toBeNull();
  });

  it('preserves the last non-429 terminal failure when later accounts return 429', () => {
    const { policy } = createPolicy();
    const forbidden = new UpstreamRequestError({ message: 'forbidden', status: 403 });
    const rateLimited = new UpstreamRequestError({
      message: 'rate limited',
      status: 429,
      headers: { retryAfter: '23' },
    });

    const allRateLimited = policy.createTokenRetryState();
    policy.recordFailure(allRateLimited, rateLimited);
    const rateLimitedResult = policy.resolveTerminalError(allRateLimited, rateLimited);

    expect(rateLimitedResult).toBeInstanceOf(ProxyAccountUnavailableError);
    expect((rateLimitedResult as ProxyAccountUnavailableError).getStatus()).toBe(429);
    expect((rateLimitedResult as ProxyAccountUnavailableError).retryAfterSeconds).toBe(23);

    const mixedFailures = policy.createTokenRetryState();
    policy.recordFailure(mixedFailures, forbidden);
    policy.recordFailure(mixedFailures, rateLimited);
    const mixedResult = policy.resolveTerminalError(mixedFailures, rateLimited);

    expect(mixedResult).toBe(forbidden);
  });

  it('identifies image 429 failures that must be recorded before grace sleep', () => {
    const { policy } = createPolicy();
    const error = new UpstreamRequestError({ message: 'rate limited', status: 429 });

    expect(policy.shouldRecordImagePenaltyBeforeGrace('gemini-3.1-pro-image', error)).toBe(true);
    expect(policy.shouldRecordImagePenaltyBeforeGrace('gemini-3.1-pro-high', error)).toBe(false);
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

  it('persists compact long-image quota evidence even when the raw marker is past 500 chars', async () => {
    proxyModelAvailabilityStore.clearAccount('acc-long-image-evidence');
    const { policy, accountLeaseService } = createPolicy();
    accountLeaseService.getRemainingRateLimitWait.mockReturnValue(3600);
    const body = `${'x'.repeat(600)} QUOTA_EXHAUSTED retry after 3600s`;

    await policy.applyUpstreamPenalty(
      'acc-long-image-evidence',
      'gemini-3-pro-image',
      new UpstreamRequestError({
        message: 'quota exhausted',
        status: 429,
        body,
      }),
    );

    const entry = proxyModelAvailabilityStore
      .getSnapshot()
      .find((candidate) => candidate.accountId === 'acc-long-image-evidence');
    expect(entry?.message).toBe('QUOTA_EXHAUSTED retry after 3600s');
    expect(entry?.message?.length).toBeLessThan(500);
    proxyModelAvailabilityStore.clearAccount('acc-long-image-evidence');
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
  it('quarantines the account for a VALIDATION_REQUIRED 403', async () => {
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
            links: [
              { description: 'Verify your account', url: 'https://accounts.google.com/verify' },
            ],
          },
        ],
      }),
    );

    expect(accountLeaseService.markAsForbidden).not.toHaveBeenCalled();
    expect(accountLeaseService.markFromUpstreamError).not.toHaveBeenCalled();
    expect(accountLeaseService.markValidationRequired).toHaveBeenCalledWith({
      accountId: 'acc-validation',
      verificationUrl: 'https://accounts.google.com/verify',
      description: 'Verify your account',
    });
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
    expect(accountLeaseService.markValidationRequired).not.toHaveBeenCalled();
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

  it.each([
    ['acc-location', 'Gemini Code Assist is not currently available in your location.'],
    [
      'acc-license',
      'You are currently configured to use a Google Cloud Project but lack a Gemini Code Assist license. (#3501)',
    ],
  ] as const)(
    'rotates away from a durable provider eligibility 403 for %s',
    async (accountId, message) => {
      const { policy, accountLeaseService } = createPolicy();

      await policy.applyUpstreamPenalty(
        accountId,
        'gemini-3-flash',
        new UpstreamRequestError({
          message,
          status: 403,
          body: JSON.stringify({ error: { message, status: 'PERMISSION_DENIED' } }),
        }),
      );

      expect(accountLeaseService.markAsForbidden).toHaveBeenCalledWith(accountId);
    },
  );

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
