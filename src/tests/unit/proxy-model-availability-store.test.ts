import { describe, expect, it } from 'vitest';
import {
  type ProxyModelAvailability,
  type ProxyModelAvailabilityPersistence,
  ModelAvailabilityService,
} from '@/modules/proxy-gateway/server/shared/services/model-availability.service';

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
  it('clears only image capability failures when an account is manually refreshed', () => {
    const store = new ModelAvailabilityService();

    store.mark('acc-1', 'gemini-3-pro-image', 'model_not_supported');
    store.mark('acc-1', 'gemini-3-flash-image', 'model_forbidden');
    store.mark('acc-1', 'gemini-3-pro', 'quota_exhausted');
    store.clearCapabilityFailures('acc-1');

    expect(store.getSnapshot()).toEqual([
      expect.objectContaining({
        accountId: 'acc-1',
        modelId: 'gemini-3-pro',
        reason: 'quota_exhausted',
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
