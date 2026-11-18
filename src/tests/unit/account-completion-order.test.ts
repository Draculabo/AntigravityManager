import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import type {
  AccountLeaseAccountStore,
  AccountLeaseUpstream,
} from '@/server/gateway/modules/account-lease/interfaces/account-lease-adapters';
import { ModelAvailabilityService } from '@/server/gateway/shared/services/model-availability.service';
import { ProxyRetryService } from '@/server/gateway/shared/services/proxy-retry.service';
import { UpstreamRequestError } from '@/server/gateway/common/exceptions/upstream-request.exception';
import {
  createAccount,
  createGateway,
  createUpstream,
  geminiTextResponse,
} from './proxy-real-path.harness';
import type { CloudAccount } from '@/modules/cloud-account/types';

vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<
    typeof import('@/server/gateway/common/utils/request-user-agent')
  >()),
  resolveRequestUserAgent: async () => 'synthetic-completion-order/0.0.0',
}));
const services: AccountLeaseService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.onModuleDestroy();
  }
});
const model = 'gemini-3-flash';
async function fixture() {
  const account = createAccount('ordered');
  account.lifecycle_generation = 'a'.repeat(32);
  const store: AccountLeaseAccountStore = {
    getAccounts: vi.fn(async () => [structuredClone(account)]),
    getAccount: vi.fn(async () => structuredClone(account)),
    assertCurrentAccount: (_id, guard) => guard(structuredClone(account)),
    async compareAndUpdateToken(id, _expected, token, guard) {
      await this.updateToken(id, token, guard);
      return true;
    },
    updateToken: vi.fn(),
    updateQuota: vi.fn(async (_id, quota, guard) => {
      guard?.(structuredClone(account));
      account.quota = quota;
    }),
    mutateHealth: vi.fn(),
  };
  const upstream: AccountLeaseUpstream = {
    fetchQuota: vi.fn(),
    fetchProjectId: vi.fn(),
    refreshAccessToken: vi.fn(),
    normalizeRefreshedOAuthClientKey: vi.fn(),
  };
  const availability = new ModelAvailabilityService();
  const lease = new AccountLeaseService(store, upstream, undefined, availability);
  services.push(lease);
  const older = await lease.getNextToken({ model, sessionKey: 'synthetic-session' });
  const newer = await lease.getNextToken({ model, sessionKey: 'synthetic-session' });
  if (!older || !newer) {
    throw new Error('Missing issued fixtures');
  }
  const retry = new ProxyRetryService(lease, { log: vi.fn(), warn: vi.fn() }, availability);
  return { lease, retry, older, newer, account, availability, store, upstream };
}

describe('account completion order and eligibility', () => {
  it.each(['success', 'error'] as const)(
    'keeps a newer error authoritative when an older request ends with %s',
    async (olderResult) => {
      const { lease, account, availability } = await fixture();
      const slots = [0, 1].map(() => ({
        entered: Promise.withResolvers<void>(),
        result: Promise.withResolvers<ReturnType<typeof geminiTextResponse>>(),
      }));
      let next = 0;
      const upstream = createUpstream({
        generate: () => {
          const slot = slots[next++];
          if (!slot) {
            throw new Error('Unexpected extra upstream dispatch');
          }
          slot.entered.resolve();
          return slot.result.promise;
        },
      });
      const service = createGateway(upstream, lease, undefined, availability).openAIService;
      const request = { model, messages: [{ role: 'user' as const, content: 'synthetic-input' }] };
      const first = service.handleChatCompletions(request).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      let second: Promise<unknown> | undefined;
      try {
        await slots[0].entered.promise;
        second = service.handleChatCompletions(request).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await slots[1].entered.promise;
        slots[1].result.reject(
          new UpstreamRequestError({
            status: 404,
            message: `Model ${upstream.calls[1].body.model} is not supported`,
          }),
        );
        expect(await second).toHaveProperty('error');
        const snapshot = availability.getSnapshot();
        expect(snapshot).toHaveLength(1);
        if (olderResult === 'success') {
          slots[0].result.resolve(geminiTextResponse('kept-output'));
          expect(JSON.stringify(await first)).toContain('kept-output');
        } else {
          slots[0].result.reject(
            new UpstreamRequestError({ status: 401, message: 'synthetic unauthorized' }),
          );
          expect(await first).toHaveProperty('error');
        }
        expect(availability.getSnapshot()).toEqual(snapshot);
        expect(lease.isRateLimited(account.id)).toBe(false);
        expect(upstream.calls).toHaveLength(2);
      } finally {
        for (const slot of slots) {
          slot.result.resolve(geminiTextResponse('cleanup'));
        }
        await first;
        await second;
      }
    },
  );

  it('does not revive issued leases after an observed OAuth block/recovery cycle', async () => {
    const { lease, older, account } = await fixture();
    account.health = { oauth: { refresh_blocked: true } };
    lease.updateAccountOAuthHealth(account.id, account.health.oauth);
    account.health = undefined;
    lease.updateAccountOAuthHealth(account.id, undefined);
    expect(lease.isLeaseCurrent(older)).toBe(false);
    expect(await lease.getNextToken({ model })).not.toBeNull();
  });

  it('does not let an older success clear protection after a newer completion', async () => {
    const { lease, retry, older, newer, availability } = await fixture();
    lease.commitSession(newer);
    availability.mark(older.id, model, 'model_not_supported');
    const snapshot = availability.getSnapshot();
    retry.markUpstreamSuccess(older.id, model, () => lease.isLeaseCurrent(older));
    expect(availability.getSnapshot()).toEqual(snapshot);
  });

  it('does not add an older error after a newer success', async () => {
    const { lease, retry, older, newer, availability } = await fixture();
    lease.commitSession(newer);
    await retry.applyUpstreamPenalty(
      older.id,
      model,
      new UpstreamRequestError({ status: 404, message: `Model ${model} is not supported` }),
      () => lease.isLeaseCurrent(older),
    );
    expect(availability.getSnapshot()).toEqual([]);
  });

  it('does not supersede an older completion merely because a newer lease was issued', async () => {
    const { lease, older } = await fixture();
    lease.commitSession(older);
    expect(lease.isLeaseCurrent(older)).toBe(true);
  });

  it('does not write an older quota reconciliation after a newer completion', async () => {
    const { lease, retry, older, newer, store, upstream } = await fixture();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    vi.mocked(upstream.fetchQuota).mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
      return { models: {} };
    });
    const pending = retry.applyUpstreamPenalty(
      older.id,
      model,
      new UpstreamRequestError({
        status: 429,
        message: 'quota exhausted',
        body: 'quota exhausted',
      }),
      () => lease.isLeaseCurrent(older),
    );
    try {
      await entered.promise;
      lease.commitSession(newer);
      resume.resolve();
      await pending;
      expect(store.updateQuota).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      await pending;
    }
  });

  const changes: Array<{ name: string; apply(account: CloudAccount): void }> = [
    {
      name: 'OAuth block',
      apply: (account) => {
        account.health = { oauth: { refresh_blocked: true } };
      },
    },
    {
      name: 'validation quarantine',
      apply: (account) => {
        account.health = {
          validation: {
            status: 'requires_action',
            reason: 'VALIDATION_REQUIRED',
            detected_at_ms: Date.now(),
            next_probe_at_ms: Date.now() + 60_000,
          },
        };
      },
    },
    {
      name: 'hard quota',
      apply: (account) => {
        account.quota = {
          models: {
            [model]: { percentage: 0, resetTime: new Date(Date.now() + 60_000).toISOString() },
          },
        };
      },
    },
  ];
  for (const change of changes) {
    it(`rejects new issue from a stale cache after stored ${change.name}`, async () => {
      const { lease, account } = await fixture();
      change.apply(account);
      expect(await lease.getNextToken({ model, allowSelectionWait: false })).toBeNull();
    });

    it(`preserves output and protection after stored ${change.name}`, async () => {
      const { lease, account, availability } = await fixture();
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const upstream = createUpstream({
        generate: async () => {
          entered.resolve();
          await resume.promise;
          return geminiTextResponse('kept-output');
        },
      });
      const gateway = createGateway(upstream, lease, undefined, availability);
      const pending = gateway.openAIService.handleChatCompletions({
        model,
        messages: [{ role: 'user', content: 'synthetic-input' }],
      });
      const outcome = pending.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      try {
        await entered.promise;
        change.apply(account);
        const executedModel = upstream.calls[0]?.body.model;
        if (!executedModel) {
          throw new Error('Missing upstream model');
        }
        availability.mark(account.id, executedModel, 'model_not_supported');
        const snapshot = availability.getSnapshot();
        resume.resolve();
        expect(JSON.stringify(await outcome)).toContain('kept-output');
        expect(availability.getSnapshot()).toEqual(snapshot);
      } finally {
        resume.resolve();
        await outcome;
      }
    });
  }
});
