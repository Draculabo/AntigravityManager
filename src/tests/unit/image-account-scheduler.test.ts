import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_CONFIG, ProxyConfigSchema, type ProxyConfig } from '@/modules/config/types';
import { setServerConfig } from '@/server/server-config';
import {
  AccountLeaseService,
  ImageAccountUnavailableError,
  ImageQueueAbortedError,
  ImageQueueTimeoutError,
} from '@/modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import { ImageAccountSchedulerService } from '@/modules/proxy-gateway/server/modules/account-lease/image-account-scheduler.service';

function configureScheduler(perAccountConcurrency: number, requestTimeout = 1): void {
  const proxy: ProxyConfig = {
    ...DEFAULT_APP_CONFIG.proxy,
    request_timeout: requestTimeout,
    image_scheduler: { per_account_concurrency: perAccountConcurrency },
  };
  setServerConfig(proxy);
}

function seedTokens(service: AccountLeaseService, accountIds: string[]): void {
  const nowSeconds = Math.floor(Date.now() / 1000);
  (service as unknown as { tokens: Map<string, unknown> }).tokens = new Map(
    accountIds.map((accountId) => [
      accountId,
      {
        account_id: accountId,
        access_token: `token-${accountId}`,
        email: `${accountId}@test.dev`,
        expires_in: 3600,
        expiry_timestamp: nowSeconds + 3600,
        project_id: `project-${accountId}`,
        refresh_token: `refresh-${accountId}`,
        token_type: 'Bearer',
      },
    ]),
  );
}

function createLeaseService(scheduler: ImageAccountSchedulerService): AccountLeaseService {
  return new AccountLeaseService(undefined, undefined, undefined, undefined, scheduler);
}

describe('ImageAccountSchedulerService', () => {
  beforeEach(() => {
    configureScheduler(2);
  });

  it('defaults missing scheduler configuration to four permits per account', () => {
    const { image_scheduler: _scheduler, ...legacyConfig } = DEFAULT_APP_CONFIG.proxy;
    const parsed = ProxyConfigSchema.parse(legacyConfig);
    expect(parsed.image_scheduler).toEqual({ per_account_concurrency: 4 });
  });

  it('accepts an explicit zero cap as a deliberate no-capacity configuration', () => {
    const parsed = ProxyConfigSchema.parse({
      ...DEFAULT_APP_CONFIG.proxy,
      image_scheduler: { per_account_concurrency: 0 },
    });
    expect(parsed.image_scheduler.per_account_concurrency).toBe(0);

    configureScheduler(0);
    const scheduler = new ImageAccountSchedulerService();
    scheduler.syncAccounts(['a']);
    expect(scheduler.getAvailableSlots()).toBe(0);
    expect(scheduler.tryAcquire('a')).toBeNull();
  });

  it('enforces the configured capacity independently for every enabled account', () => {
    const scheduler = new ImageAccountSchedulerService();
    scheduler.syncAccounts(['a', 'b', 'c']);

    const permits = ['a', 'b', 'c'].flatMap((accountId) => [
      scheduler.tryAcquire(accountId),
      scheduler.tryAcquire(accountId),
    ]);

    expect(permits.every(Boolean)).toBe(true);
    expect(scheduler.getAvailableSlots()).toBe(0);
    expect(scheduler.tryAcquire('a')).toBeNull();
    permits[0]?.release();
    expect(scheduler.tryAcquire('a')).not.toBeNull();
  });

  it('releases idempotently and preserves in-flight usage across remove and re-add', () => {
    configureScheduler(1);
    const scheduler = new ImageAccountSchedulerService();
    scheduler.syncAccounts(['a']);
    const permit = scheduler.tryAcquire('a');
    expect(permit).not.toBeNull();

    scheduler.syncAccounts([]);
    expect(scheduler.tryAcquire('a')).toBeNull();
    scheduler.syncAccounts(['a']);
    expect(scheduler.tryAcquire('a')).toBeNull();

    permit?.release();
    permit?.release();
    expect(scheduler.getInUseFor('a')).toBe(0);
    expect(scheduler.getAvailableSlots()).toBe(1);
  });

  it('cleans up an aborted capacity waiter', async () => {
    const scheduler = new ImageAccountSchedulerService();
    const controller = new AbortController();
    const wait = scheduler.waitForChange(1000, controller.signal);
    controller.abort();
    await expect(wait).resolves.toBe('aborted');
  });
});

describe('AccountLeaseService image scheduling', () => {
  it('admits only six of eight requests across three cap-two accounts until permits release', async () => {
    configureScheduler(2, 1);
    const scheduler = new ImageAccountSchedulerService();
    const service = createLeaseService(scheduler);
    seedTokens(service, ['a', 'b', 'c']);
    const resolved: Awaited<ReturnType<AccountLeaseService['getNextImageToken']>>[] = [];
    const requests = Array.from({ length: 8 }, () =>
      service.getNextImageToken({ model: 'gemini-3.1-flash-image' }).then((lease) => {
        resolved.push(lease);
        return lease;
      }),
    );

    await vi.waitFor(() => expect(resolved).toHaveLength(6));
    expect(scheduler.getInUseFor('a')).toBe(2);
    expect(scheduler.getInUseFor('b')).toBe(2);
    expect(scheduler.getInUseFor('c')).toBe(2);

    const initialLeases = resolved.slice();
    initialLeases.forEach(({ permit }) => permit.release());
    const allLeases = await Promise.all(requests);
    expect(allLeases).toHaveLength(8);
    allLeases.slice(initialLeases.length).forEach(({ permit }) => permit.release());
    expect(scheduler.getAvailableSlots()).toBe(6);
  });

  it('skips a saturated preferred account and selects another eligible account', async () => {
    configureScheduler(1);
    const scheduler = new ImageAccountSchedulerService();
    const service = createLeaseService(scheduler);
    seedTokens(service, ['a', 'b']);
    service.setPreferredAccount('a');

    const first = await service.getNextImageToken({ model: 'gemini-3.1-flash-image' });
    const second = await service.getNextImageToken({ model: 'gemini-3.1-flash-image' });

    expect(first.token.id).toBe('a');
    expect(second.token.id).toBe('b');
    first.permit.release();
    second.permit.release();
  });

  it('periodically reselects an account that becomes eligible without a capacity notification', async () => {
    configureScheduler(1, 1);
    const scheduler = new ImageAccountSchedulerService();
    const service = createLeaseService(scheduler);
    seedTokens(service, ['busy', 'cooling']);
    service.setPreferredAccount('busy');
    const tokens = (
      service as unknown as { tokens: Map<string, { validation_blocked_until_ms?: number }> }
    ).tokens;
    const cooling = tokens.get('cooling');
    if (cooling) {
      cooling.validation_blocked_until_ms = Date.now() + 40;
    }

    const held = await service.getNextImageToken({ model: 'gemini-3.1-flash-image' });
    const queued = service.getNextImageToken({ model: 'gemini-3.1-flash-image' });
    const selected = await queued;

    expect(held.token.id).toBe('busy');
    expect(selected.token.id).toBe('cooling');
    held.permit.release();
    selected.permit.release();
  });

  it('queues when all eligible accounts are busy and wakes after one release', async () => {
    configureScheduler(1, 1);
    const scheduler = new ImageAccountSchedulerService();
    const service = createLeaseService(scheduler);
    seedTokens(service, ['a']);

    const first = await service.getNextImageToken({ model: 'gemini-3.1-flash-image' });
    let settled = false;
    const queued = service.getNextImageToken({ model: 'gemini-3.1-flash-image' }).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    first.permit.release();
    const second = await queued;
    expect(second.token.id).toBe('a');
    second.permit.release();
  });

  it('distinguishes unavailable accounts, queue timeout, and cancellation', async () => {
    configureScheduler(1, 0.03);
    const emptyScheduler = new ImageAccountSchedulerService();
    const emptyService = createLeaseService(emptyScheduler);
    seedTokens(emptyService, ['blocked']);
    const blockedTokens = (
      emptyService as unknown as { tokens: Map<string, { validation_blocked_until_ms?: number }> }
    ).tokens;
    const blocked = blockedTokens.get('blocked');
    if (blocked) {
      blocked.validation_blocked_until_ms = Date.now() + 60_000;
    }
    await expect(
      emptyService.getNextImageToken({ model: 'gemini-3.1-flash-image' }),
    ).rejects.toBeInstanceOf(ImageAccountUnavailableError);

    const scheduler = new ImageAccountSchedulerService();
    const service = createLeaseService(scheduler);
    seedTokens(service, ['a']);
    const held = await service.getNextImageToken({ model: 'gemini-3.1-flash-image' });
    await expect(
      service.getNextImageToken({ model: 'gemini-3.1-flash-image' }),
    ).rejects.toBeInstanceOf(ImageQueueTimeoutError);

    configureScheduler(1, 1);
    const controller = new AbortController();
    const cancelled = service.getNextImageToken({
      model: 'gemini-3.1-flash-image',
      signal: controller.signal,
    });
    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(ImageQueueAbortedError);
    held.permit.release();
  });

  it('treats an explicit zero cap as a queue that reaches the normal deadline', async () => {
    configureScheduler(0, 0.01);
    const scheduler = new ImageAccountSchedulerService();
    const service = createLeaseService(scheduler);
    seedTokens(service, ['a']);

    await expect(
      service.getNextImageToken({ model: 'gemini-3.1-flash-image' }),
    ).rejects.toBeInstanceOf(ImageQueueTimeoutError);
    expect(scheduler.getInUseFor('a')).toBe(0);
  });
});
