import { logger } from '@/shared/logging/logger';

export type ThoughtRecoveryOwner = 'signature-cache' | 'responses';
export interface ThoughtRecoveryEffect {
  owner: ThoughtRecoveryOwner;
  state: 'complete' | 'partial' | 'failed' | 'unavailable';
  removed: number;
  unknown: number;
}
type RecoveryPeer = (sessionKey?: string) => Promise<{ removed: number; unknown: number }>;
const peers = new Map<ThoughtRecoveryOwner, RecoveryPeer>();
const owners: readonly ThoughtRecoveryOwner[] = ['signature-cache', 'responses'];

/** The two actual runtime owners register themselves; no session aliases are guessed. */
export function registerThoughtRecoveryPeer(
  owner: ThoughtRecoveryOwner,
  peer: RecoveryPeer,
): () => void {
  peers.set(owner, peer);
  return () => {
    if (peers.get(owner) === peer) {
      peers.delete(owner);
    }
  };
}

export async function invalidateThoughtRecoveryPeers(sessionKey?: string): Promise<{
  recoveryComplete: boolean;
  recovery: ThoughtRecoveryEffect[];
}> {
  const snapshot = owners.map((owner) => ({ owner, peer: peers.get(owner) }));
  const recovery = await Promise.all(
    snapshot.map(async ({ owner, peer }): Promise<ThoughtRecoveryEffect> => {
      if (!peer) {
        return { owner, state: 'unavailable', removed: 0, unknown: 0 };
      }
      try {
        const result = await peer(sessionKey);
        return { owner, ...result, state: result.unknown > 0 ? 'partial' : 'complete' };
      } catch (error) {
        // The caller reports a partial durable outcome. Do not replay a deletion or
        // expose the peer's private file paths through the receipt.
        logger.warn(`Thought recovery peer ${owner} deletion failed`, error);
        return { owner, state: 'failed', removed: 0, unknown: 0 };
      }
    }),
  );
  return { recoveryComplete: recovery.every((effect) => effect.state === 'complete'), recovery };
}
