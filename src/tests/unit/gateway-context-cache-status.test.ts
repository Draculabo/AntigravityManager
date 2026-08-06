import { afterEach, describe, expect, it, vi } from 'vitest';

import { getContextCacheStatus } from '@/modules/proxy-gateway/ipc/handlers';
import { explicitContextCacheManager } from '@/modules/proxy-gateway/server/modules/gemini/explicit-context-cache.store';

describe('getContextCacheStatus', () => {
  afterEach(() => {
    explicitContextCacheManager.clear();
    vi.unstubAllEnvs();
  });

  it('returns only enabled state and numeric diagnostic counters', () => {
    expect(getContextCacheStatus()).toEqual({
      enabled: true,
      stats: {
        activeEntries: 0,
        creationFailures: 0,
        creations: 0,
        hits: 0,
        invalidations: 0,
        lookups: 0,
      },
    });
  });

  it('reports when explicit caching is disabled through runtime configuration', () => {
    vi.stubEnv('PROXY_CONTEXT_CACHE_ENABLED', 'false');

    expect(getContextCacheStatus().enabled).toBe(false);
  });
});
