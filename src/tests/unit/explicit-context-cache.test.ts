import { describe, expect, it, vi } from 'vitest';

import {
  ExplicitContextCacheManager,
  type ExplicitContextCacheCandidate,
} from '@/modules/proxy-gateway/server/modules/gemini/explicit-context-cache.store';

function createCandidate(manager: ExplicitContextCacheManager): ExplicitContextCacheCandidate {
  const candidate = manager.createCandidate({
    model: 'gemini-2.5-pro',
    project: 'project-a',
    requestId: 'request-a',
    requestType: 'agent',
    userAgent: 'test-agent',
    request: {
      contents: [],
      systemInstruction: {
        parts: [{ text: 'static prefix '.repeat(700) }],
      },
    },
  });

  if (!candidate) {
    throw new Error('Expected static context to be eligible for explicit caching');
  }
  return candidate;
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
