import { describe, expect, it, vi } from 'vitest';
import {
  type ProxyModelAvailability,
  type ProxyModelAvailabilityPersistence,
  ModelAvailabilityService,
} from '@/server/gateway/shared/services/model-availability.service';

function createPersistence(initial: ProxyModelAvailability[] = []): {
  persistence: ProxyModelAvailabilityPersistence;
  read: () => ProxyModelAvailability[];
} {
  let entries = structuredClone(initial);
  return {
    persistence: {
      load: () => structuredClone(entries),
      save: (nextEntries) => {
        entries = structuredClone(nextEntries);
      },
    },
    read: () => structuredClone(entries),
  };
}

describe('ModelAvailabilityService', () => {
  it('reopens an image model only when a refreshed quota snapshot advertises it', () => {
    const store = new ModelAvailabilityService();
    const model = 'gemini-3.1-flash-image';
    store.mark('acc-1', model, 'model_forbidden');
    store.mark('acc-2', model, 'model_forbidden');

    store.clearCapabilityFailures('acc-1', ['gemini-3.8-flash-high']);
    expect(store.isCapabilityBlocked('acc-1', model)).toBe(true);

    store.clearCapabilityFailures('acc-1', [model]);
    expect(store.isCapabilityBlocked('acc-1', model)).toBe(false);
    expect(store.isCapabilityBlocked('acc-2', model)).toBe(true);
  });
  it('removes only the deleted account from a cold durable snapshot', () => {
    const durable = createPersistence();
    const original = new ModelAvailabilityService(durable.persistence);
    original.mark('acc-1', 'gemini-3-pro', 'model_forbidden');
    original.mark('acc-2', 'gemini-3-pro', 'quota_exhausted');
    const retained = durable.read().filter((entry) => entry.accountId === 'acc-2');
    const cold = new ModelAvailabilityService(durable.persistence);
    cold.clearAccountOrThrow('acc-1');
    expect(durable.read()).toEqual(retained);
    expect(cold.getSnapshot()).toEqual(retained);
    expect(new ModelAvailabilityService(durable.persistence).getSnapshot()).toEqual(retained);
  });

  it('reports a failed cleanup write and permits an explicit retry', () => {
    const durable = createPersistence();
    const store = new ModelAvailabilityService(durable.persistence);
    store.mark('acc-1', 'gemini-3-pro', 'model_forbidden');
    store.mark('acc-2', 'gemini-3-pro', 'quota_exhausted');
    const before = durable.read();
    const error = new Error('Synthetic cleanup write failure');
    const save = vi.spyOn(durable.persistence, 'save').mockImplementationOnce(() => {
      throw error;
    });
    expect(() => store.clearAccountOrThrow('acc-1')).toThrow(error);
    expect(store.getSnapshot()).toEqual(before);
    expect(durable.read()).toEqual(before);
    store.clearAccountOrThrow('acc-1');
    expect(save).toHaveBeenCalledTimes(2);
    expect(durable.read()).toEqual(before.filter((entry) => entry.accountId === 'acc-2'));
  });

  it.each(['unreadable', 'invalid', 'null'] as const)(
    'does not overwrite unrelated durable state when the initial read is %s',
    (mode) => {
      const durable = createPersistence();
      const original = new ModelAvailabilityService(durable.persistence);
      original.mark('acc-2', 'gemini-3-pro', 'quota_exhausted');
      const before = durable.read();
      const read = vi.spyOn(durable.persistence, 'load');
      if (mode === 'unreadable') {
        read.mockImplementation(() => {
          throw new Error('Synthetic read failure');
        });
      } else {
        read.mockReturnValue(mode === 'null' ? null : { invalid: true });
      }
      const save = vi.spyOn(durable.persistence, 'save');
      const cold = new ModelAvailabilityService(durable.persistence);
      expect(() => cold.clearAccountOrThrow('acc-1')).toThrow();
      cold.mark('acc-1', 'gemini-3-flash', 'model_forbidden');
      expect(save).not.toHaveBeenCalled();
      read.mockImplementation(() => durable.read());
      cold.clearAccountOrThrow('acc-1');
      expect(durable.read()).toEqual(before);
      expect(cold.getSnapshot()).toEqual(before);
    },
  );

  it('distinguishes capability denials from quota and other accounts', () => {
    const store = new ModelAvailabilityService();

    store.mark('acc-1', 'gemini-3.1-pro-high', 'model_not_supported');
    store.mark('acc-1', 'gemini-3.6-flash-low', 'model_forbidden');
    store.mark('acc-1', 'gemini-3-pro', 'model_not_supported');
    store.mark('acc-1', 'gemini-3.1-flash-lite', 'quota_exhausted');
    expect(store.isCapabilityBlocked('acc-1', 'models/gemini-pro-agent')).toBe(true);
    expect(store.isCapabilityBlocked('acc-1', 'gemini-3.1-pro-low')).toBe(true);
    expect(store.isCapabilityBlocked('acc-1', 'gemini-3.6-flash-high')).toBe(true);
    expect(store.isCapabilityBlocked('acc-1', 'gemini-3-pro')).toBe(true);
    expect(store.isCapabilityBlocked('acc-1', 'gemini-3.1-flash-lite')).toBe(false);
    expect(store.isCapabilityBlocked('acc-2', 'gemini-3.1-pro-high')).toBe(false);
  });

  it('shares a capability denial only within its known model family', () => {
    const store = new ModelAvailabilityService();

    store.mark('acc-1', 'gemini-3.7-flash-low', 'model_not_supported');

    expect(store.isCapabilityBlocked('acc-1', 'gemini-3.7-flash-tiered')).toBe(true);
    expect(store.isCapabilityBlocked('acc-1', 'gemini-3.6-flash-high')).toBe(true);
    expect(store.isCapabilityBlocked('acc-1', 'gemini-3.5-flash-high')).toBe(false);
    expect(store.getSnapshot()).toEqual([
      expect.objectContaining({
        accountId: 'acc-1',
        modelId: 'gemini-3.7-flash',
        reason: 'model_not_supported',
      }),
    ]);
  });

  it('clears only the successful model entry', () => {
    const store = new ModelAvailabilityService();

    store.mark('acc-1', 'models/gemini-3.1-pro-high', 'rate_limited');
    store.mark('acc-1', 'gemini-3.1-flash-lite', 'quota_exhausted');

    expect(store.clearModel('acc-1', 'gemini-3.1-pro-high')).toBe(true);
    expect(store.getSnapshot()).toEqual([
      expect.objectContaining({
        accountId: 'acc-1',
        modelId: 'gemini-3.1-flash-lite',
        reason: 'quota_exhausted',
      }),
    ]);
  });

  it('preserves a sibling image capability failure when another image model succeeds', () => {
    const store = new ModelAvailabilityService();

    store.mark('acc-1', 'gemini-3-pro-image', 'model_not_supported');
    store.mark('acc-1', 'gemini-3.1-flash-image', 'model_forbidden');

    expect(store.clearModel('acc-1', 'gemini-3.1-flash-image')).toBe(true);
    expect(store.getSnapshot()).toEqual([
      expect.objectContaining({
        accountId: 'acc-1',
        modelId: 'gemini-pro-image',
        reason: 'model_not_supported',
      }),
    ]);
  });

  it('clears a successful family capability denial for every tier alias', () => {
    const store = new ModelAvailabilityService();

    store.mark('acc-1', 'gemini-3.7-flash-low', 'model_forbidden');
    expect(store.isCapabilityBlocked('acc-1', 'gemini-3.7-flash-high')).toBe(true);

    expect(store.clearModel('acc-1', 'gemini-3.7-flash-medium')).toBe(true);
    expect(store.isCapabilityBlocked('acc-1', 'gemini-3.7-flash-high')).toBe(false);
  });

  it('clears every persisted alias in a successful image model family', () => {
    const store = new ModelAvailabilityService();

    store.mark('acc-1', 'gemini-3-pro-image', 'quota_exhausted');
    store.mark('acc-1', 'gemini-3.1-pro-image', 'rate_limited');
    store.mark('acc-1', 'gemini-3-flash-image', 'rate_limited');

    expect(store.clearModelFamily('acc-1', 'gemini-pro-image')).toBe(2);
    expect(store.getSnapshot()).toEqual([
      expect.objectContaining({ modelId: 'gemini-3-flash-image' }),
    ]);
  });

  it('persists live status details and restores them after restart', () => {
    const durableState = createPersistence();
    const firstStore = new ModelAvailabilityService(durableState.persistence);
    const unavailableUntil = Date.now() + 60_000;

    firstStore.mark('acc-1', 'gemini-pro-agent', 'rate_limited', unavailableUntil, {
      status: 429,
      detectedAt: 1_777_000_000_000,
      message: 'Resource has been exhausted',
    });

    expect(durableState.read()).toEqual([
      {
        accountId: 'acc-1',
        modelId: 'gemini-pro-agent',
        reason: 'rate_limited',
        unavailableUntil,
        status: 429,
        detectedAt: 1_777_000_000_000,
        message: 'Resource has been exhausted',
      },
    ]);

    const restartedStore = new ModelAvailabilityService(durableState.persistence);
    expect(restartedStore.getSnapshot()).toEqual(durableState.read());

    restartedStore.clearModel('acc-1', 'gemini-pro-agent');
    expect(durableState.read()).toEqual([]);
  });

  it('drops expired persisted entries during hydration', () => {
    const durableState = createPersistence([
      {
        accountId: 'acc-1',
        modelId: 'gemini-3-flash',
        reason: 'rate_limited',
        unavailableUntil: Date.now() - 1,
        detectedAt: Date.now() - 11 * 60_000,
      },
    ]);
    const store = new ModelAvailabilityService(durableState.persistence);

    expect(store.getSnapshot()).toEqual([]);
    expect(durableState.read()).toEqual([]);
  });
});
