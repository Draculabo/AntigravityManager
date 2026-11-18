import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProxyRetryService } from '@/server/gateway/shared/services/proxy-retry.service';
import { ModelAvailabilityService } from '@/server/gateway/shared/services/model-availability.service';
import { UpstreamRequestError } from '@/server/gateway/common/exceptions/upstream-request.exception';
import { createAccount, createLease } from './proxy-real-path.harness';

const model = 'gemini-3-flash';
function error(seconds?: string, body = 'RESOURCE_EXHAUSTED') {
  return new UpstreamRequestError({
    message: 'limited',
    status: 429,
    headers: seconds ? { retryAfter: seconds } : undefined,
    body,
  });
}
async function fixture(size: number, timeoutMs = 300_000) {
  const lease = createLease(['policy-a', 'policy-b'].slice(0, size).map((id) => createAccount(id)));
  const policy = new ProxyRetryService(
    lease,
    { log: vi.fn(), warn: vi.fn() },
    new ModelAvailabilityService(),
  );
  const state = policy.createTokenRetryState(timeoutMs);
  await policy.getMaxRetryAttempts(model, false, state);
  return { lease, policy, state };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ordinary retry policy boundaries', () => {
  it.each([
    ['29.8', true, 30_000],
    ['29.801', false, 0],
    ['60', false, 0],
  ] as const)(
    'counts the buffer inside the single-account grace cap: %s seconds',
    async (seconds, allowed, waited) => {
      const { policy, state } = await fixture(1);
      const token = await policy.selectRetryToken(state, model);
      const failure = error(seconds);
      policy.recordFailure(state, failure);
      const prepared = policy.prepareGraceRetry(state, token!, failure, 'policy');
      await vi.runAllTimersAsync();
      expect(await prepared).toBe(allowed);
      expect(Date.now()).toBe(waited);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    ['4.8', true, 5000],
    ['4.801', false, 0],
  ] as const)(
    'allows only a second-round grace whose actual wait fits five seconds: %s',
    async (seconds, allowed, waited) => {
      const { policy, state } = await fixture(2);
      const first = await policy.selectRetryToken(state, model);
      const failure = error(seconds);
      policy.recordFailure(state, failure);
      expect(await policy.prepareGraceRetry(state, first!, failure, 'policy')).toBe(false);
      const second = policy.selectRetryToken(state, model);
      await vi.runAllTimersAsync();
      await second;
      policy.recordFailure(state, failure);
      const third = policy.selectRetryToken(state, model);
      await vi.runAllTimersAsync();
      const token = await third;
      policy.recordFailure(state, failure);
      const start = Date.now();
      const prepared = policy.prepareGraceRetry(state, token!, failure, 'policy');
      await vi.runAllTimersAsync();
      expect(await prepared).toBe(allowed);
      expect(Date.now() - start).toBe(waited);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('keeps the unhinted single-account backoff and grace outside the normal budget', async () => {
    const { policy, state } = await fixture(1);
    const token = await policy.selectRetryToken(state, model);
    const failure = error();
    policy.recordFailure(state, failure);
    const grace = policy.prepareGraceRetry(state, token!, failure, 'policy');
    await vi.runAllTimersAsync();
    expect(await grace).toBe(true);
    expect(Date.now()).toBe(3000);
    expect(await policy.selectRetryToken(state, model)).toEqual(token);
    policy.recordFailure(state, failure);
    expect(await policy.prepareGraceRetry(state, token!, failure, 'policy')).toBe(false);
    const next = policy.selectRetryToken(state, model);
    await vi.runAllTimersAsync();
    expect(await next).toEqual(token);
    expect(Date.now()).toBe(6000);
    policy.recordFailure(state, failure);
    const last = policy.selectRetryToken(state, model);
    await vi.runAllTimersAsync();
    expect(await last).toEqual(token);
    expect(Date.now()).toBe(12_000);
    policy.recordFailure(state, failure);
    expect(await policy.selectRetryToken(state, model)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not renew the deadline after a slow upstream failure', async () => {
    const { policy, state } = await fixture(1, 15_000);
    const token = await policy.selectRetryToken(state, model);
    await vi.advanceTimersByTimeAsync(5000);
    const failure = error('12');
    policy.recordFailure(state, failure);
    expect(await policy.prepareGraceRetry(state, token!, failure, 'policy')).toBe(false);
    expect(await policy.selectRetryToken(state, model)).toBeNull();
    expect(Date.now()).toBe(5000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses bounded transient waiting but never clears a newly extended lock', async () => {
    const { policy, state, lease } = await fixture(2);
    const first = await policy.selectRetryToken(state, model);
    policy.recordFailure(state, error('20'));
    const next = policy.selectRetryToken(state, model);
    await vi.runAllTimersAsync();
    await next;
    policy.recordFailure(state, error('20'));
    lease.getOrdinaryRetryWaitMs.mockReturnValue(20_000);
    lease.getNextToken.mockResolvedValue(null);
    const pending = policy.selectRetryToken(state, model);
    await vi.runAllTimersAsync();
    expect(await pending).toBeNull();
    expect(Date.now()).toBe(12_050);
    expect(lease.markModelSuccess).not.toHaveBeenCalled();
    expect(first?.id).toBe('policy-a');
    expect(vi.getTimerCount()).toBe(0);
  });
});
