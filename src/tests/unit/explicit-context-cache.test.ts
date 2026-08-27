import { describe, expect, it, vi } from 'vitest';

import {
  ExplicitContextCacheManager,
  type ExplicitContextCacheCandidate,
} from '@/modules/proxy-gateway/server/modules/gemini/explicit-context-cache.store';

function createCandidate(
  manager: ExplicitContextCacheManager,
  suffix = '',
): ExplicitContextCacheCandidate {
  const candidate = manager.createCandidate({
    model: 'gemini-2.5-pro',
    project: 'project-a',
    requestId: `request-${suffix || 'a'}`,
    requestType: 'agent',
    userAgent: 'test-agent',
    request: {
      contents: [],
      systemInstruction: {
        parts: [{ text: `${'static prefix '.repeat(700)}${suffix}` }],
      },
    },
  });

  if (!candidate) {
    throw new Error('Expected static context to be eligible for explicit caching');
  }
  return candidate;
}

function getFailureCooldownCount(manager: ExplicitContextCacheManager): number {
  return (
    manager as unknown as {
      failedUntil: Map<string, number>;
    }
  ).failedUntil.size;
}

describe('ExplicitContextCacheManager', () => {
  it('deduplicates concurrent cache creation and reuses the returned resource name', async () => {
    const manager = new ExplicitContextCacheManager();
    const candidate = createCandidate(manager);
    const create = vi.fn(async () => ({
      expireTime: '2099-01-01T00:00:00Z',
      name: 'projects/project-a/locations/us-central1/cachedContents/cache-a',
    }));

    const [first, second] = await Promise.all([
      manager.resolve(candidate, create),
      manager.resolve(candidate, create),
    ]);
    const third = await manager.resolve(candidate, create);

    expect(first).toBe('projects/project-a/locations/us-central1/cachedContents/cache-a');
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
    expect(manager.getStats()).toMatchObject({
      activeEntries: 1,
      creations: 1,
      hits: 1,
      lookups: 3,
    });
  });

  it('keeps recently used cache entries when capacity eviction runs', async () => {
    const manager = new ExplicitContextCacheManager();
    const candidates = Array.from({ length: 501 }, (_, index) =>
      createCandidate(manager, `-capacity-${index}`),
    );

    for (let index = 0; index < 500; index += 1) {
      await manager.resolve(candidates[index], async () => ({
        expireTime: '2099-01-01T00:00:00Z',
        name: `projects/project-a/locations/us-central1/cachedContents/cache-${index}`,
      }));
    }

    const firstCreate = vi.fn(async () => ({
      expireTime: '2099-01-01T00:00:00Z',
      name: 'projects/project-a/locations/us-central1/cachedContents/cache-first-recreated',
    }));
    await manager.resolve(candidates[0], firstCreate);
    expect(firstCreate).not.toHaveBeenCalled();

    await manager.resolve(candidates[500], async () => ({
      expireTime: '2099-01-01T00:00:00Z',
      name: 'projects/project-a/locations/us-central1/cachedContents/cache-500',
    }));

    await manager.resolve(candidates[0], firstCreate);
    expect(firstCreate).not.toHaveBeenCalled();

    const secondCreate = vi.fn(async () => ({
      expireTime: '2099-01-01T00:00:00Z',
      name: 'projects/project-a/locations/us-central1/cachedContents/cache-second-recreated',
    }));
    await manager.resolve(candidates[1], secondCreate);
    expect(secondCreate).toHaveBeenCalledTimes(1);
  });

  it('prunes expired failure cooldowns while resolving new cache candidates', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-16T00:00:00Z'));
      const manager = new ExplicitContextCacheManager();

      for (let index = 0; index < 25; index += 1) {
        await manager.resolve(createCandidate(manager, `-${index}`), async () => null);
      }
      expect(getFailureCooldownCount(manager)).toBe(25);

      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      await manager.resolve(createCandidate(manager, '-success'), async () => ({
        expireTime: '2099-01-01T00:00:00Z',
        name: 'projects/project-a/locations/us-central1/cachedContents/cache-success',
      }));

      expect(getFailureCooldownCount(manager)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not create cache candidates for image generation requests', () => {
    const manager = new ExplicitContextCacheManager();

    expect(
      manager.createCandidate({
        model: 'gemini-3-pro-image',
        project: 'project-a',
        requestId: 'request-image',
        requestType: 'image_gen',
        userAgent: 'test-agent',
        request: {
          contents: [],
          systemInstruction: {
            parts: [{ text: 'static prefix '.repeat(700) }],
          },
        },
      }),
    ).toBeNull();
  });
});
