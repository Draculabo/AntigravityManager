import { describe, expect, it, vi } from 'vitest';
import { ThoughtHydrationRequests } from '@/modules/proxy-gateway/thought-store/thought-hydration-requests';
import type { ThoughtRecord } from '@/modules/proxy-gateway/thought-store/thought-store.types';

describe('shared hydration request ownership', () => {
  it('aborts the underlying operation only after its final subscriber cancels', async () => {
    const requests = new ThoughtHydrationRequests();
    let sharedSignal: AbortSignal | undefined;
    let finish!: (records: ThoughtRecord[]) => void;
    const load = vi.fn((signal: AbortSignal) => {
      sharedSignal = signal;
      return new Promise<ThoughtRecord[]>((resolve) => {
        finish = resolve;
      });
    });
    const a = new AbortController(),
      b = new AbortController();
    const first = requests.run('shared', load, a.signal),
      second = requests.run('shared', load, b.signal);
    const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const secondRejected = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    a.abort();
    await firstRejected;
    expect(sharedSignal?.aborted).toBe(false);
    b.abort();
    await secondRejected;
    expect(sharedSignal?.aborted).toBe(true);
    expect(load).toHaveBeenCalledOnce();
    finish([]);
    await requests.waitForIdle();
    expect(await requests.run('shared', async () => [])).toEqual([]);
  });
});
