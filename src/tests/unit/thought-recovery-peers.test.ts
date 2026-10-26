import { afterEach, expect, it, vi } from 'vitest';
import {
  invalidateThoughtRecoveryPeers,
  registerThoughtRecoveryPeer,
} from '@/modules/proxy-gateway/thought-store/thought-recovery-peers';
const release: Array<() => void> = [];
afterEach(() => {
  for (const close of release.splice(0)) {
    close();
  }
});
it('reports both actual owners without retrying a partial or failed deletion', async () => {
  const signatures = vi.fn(async () => ({ removed: 3, unknown: 1 }));
  const responses = vi.fn(async () => {
    throw new Error('synthetic private path');
  });
  release.push(
    registerThoughtRecoveryPeer('signature-cache', signatures),
    registerThoughtRecoveryPeer('responses', responses),
  );
  expect(await invalidateThoughtRecoveryPeers('client-A')).toEqual({
    recoveryComplete: false,
    recovery: [
      { owner: 'signature-cache', state: 'partial', removed: 3, unknown: 1 },
      { owner: 'responses', state: 'failed', removed: 0, unknown: 0 },
    ],
  });
  expect(signatures).toHaveBeenCalledExactlyOnceWith('client-A');
  expect(responses).toHaveBeenCalledExactlyOnceWith('client-A');
});
it('does not turn a missing owner into confirmed zero and preserves a replacement owner registration', async () => {
  const first = registerThoughtRecoveryPeer('responses', async () => ({ removed: 9, unknown: 0 }));
  const current = vi.fn(async () => ({ removed: 2, unknown: 0 }));
  release.push(registerThoughtRecoveryPeer('responses', current));
  first();
  expect(await invalidateThoughtRecoveryPeers()).toEqual({
    recoveryComplete: false,
    recovery: [
      { owner: 'signature-cache', state: 'unavailable', removed: 0, unknown: 0 },
      { owner: 'responses', state: 'complete', removed: 2, unknown: 0 },
    ],
  });
  expect(current).toHaveBeenCalledExactlyOnceWith(undefined);
});
