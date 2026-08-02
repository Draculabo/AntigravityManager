import { describe, expect, it } from 'vitest';
import { LocalAccountDiscoveryService } from '@/modules/cloud-account/local-import/local-account-discovery.service';
import type {
  LocalAccountDiscoverySource,
  LocalAccountSourceResult,
} from '@/modules/cloud-account/local-import/types';

function createSource(
  id: LocalAccountDiscoverySource['id'],
  result: LocalAccountSourceResult | (() => Promise<LocalAccountSourceResult>),
): LocalAccountDiscoverySource {
  return {
    id,
    discover: typeof result === 'function' ? result : async () => result,
  };
}

describe('LocalAccountDiscoveryService', () => {
  it('deduplicates the same refresh token across sources without serializing secrets', async () => {
    const refreshToken = 'refresh-secret-shared';
    const accessToken = 'access-secret-keyring';
    const service = new LocalAccountDiscoveryService({
      digestKey: Buffer.alloc(32, 7),
      sources: [
        createSource('antigravity-keyring', {
          candidates: [
            {
              source: { id: 'antigravity-keyring' },
              credential: {
                accessToken,
                refreshToken,
                expiryTimestamp: 1_800_000_000,
              },
            },
          ],
          failures: [],
          inspectedLocations: 1,
        }),
        createSource('antigravity-classic-db', {
          candidates: [
            {
              source: {
                id: 'antigravity-classic-db',
                location: 'classic-state.vscdb',
              },
              credential: {
                refreshToken,
                projectId: 'project-from-db',
              },
            },
          ],
          failures: [],
          inspectedLocations: 1,
        }),
        createSource('legacy-agent', {
          candidates: [
            {
              source: {
                id: 'legacy-agent',
                location: 'legacy-account.json',
              },
              credential: {
                refreshToken,
              },
              emailHint: 'user@example.com',
            },
          ],
          failures: [],
          inspectedLocations: 1,
        }),
      ],
    });

    const session = await service.discover();

    expect(session.result.accounts).toHaveLength(1);
    expect(session.result.duplicateCount).toBe(2);
    expect(session.result.accounts[0]).toMatchObject({
      emailHints: ['user@example.com'],
      hasAccessToken: true,
      projectId: 'project-from-db',
      sources: [
        { id: 'antigravity-keyring' },
        { id: 'antigravity-classic-db', location: 'classic-state.vscdb' },
        { id: 'legacy-agent', location: 'legacy-account.json' },
      ],
    });

    const fingerprint = session.result.accounts[0].fingerprint;
    expect(session.getCredential(fingerprint)).toEqual({
      accessToken,
      refreshToken,
      projectId: 'project-from-db',
      expiryTimestamp: 1_800_000_000,
    });

    const serializedResult = JSON.stringify(session.result);
    expect(serializedResult).not.toContain(refreshToken);
    expect(serializedResult).not.toContain(accessToken);
    const serializedSession = JSON.stringify(session);
    expect(serializedSession).not.toContain(refreshToken);
    expect(serializedSession).not.toContain(accessToken);
  });

  it('keeps partial successes and sanitizes thrown source errors', async () => {
    const leakedToken = 'refresh-token-must-not-leak';
    const service = new LocalAccountDiscoveryService({
      digestKey: Buffer.alloc(32, 8),
      sources: [
        createSource('antigravity-keyring', async () => {
          throw new Error(`permission denied for ${leakedToken}`);
        }),
        createSource('antigravity-ide-db', {
          candidates: [
            {
              source: { id: 'antigravity-ide-db', location: 'ide-state.vscdb' },
              credential: { refreshToken: 'healthy-refresh-token' },
            },
          ],
          failures: [],
          inspectedLocations: 1,
        }),
      ],
    });

    const session = await service.discover();

    expect(session.result.accounts).toHaveLength(1);
    expect(session.result.failures).toEqual([
      {
        source: { id: 'antigravity-keyring' },
        code: 'permission-denied',
        message: 'The local credential source denied access.',
      },
    ]);
    expect(JSON.stringify(session.result)).not.toContain(leakedToken);
  });

  it('reports same-email candidates separately until network validation can merge them', async () => {
    const service = new LocalAccountDiscoveryService({
      digestKey: Buffer.alloc(32, 9),
      sources: [
        createSource('legacy-agent', {
          candidates: [
            {
              source: { id: 'legacy-agent', location: 'a.json' },
              credential: { refreshToken: 'refresh-a' },
              emailHint: 'Same@Example.com',
            },
            {
              source: { id: 'legacy-agent', location: 'b.json' },
              credential: { refreshToken: 'refresh-b' },
              emailHint: 'same@example.com',
            },
          ],
          failures: [],
          inspectedLocations: 2,
        }),
      ],
    });

    const session = await service.discover();

    expect(session.result.accounts).toHaveLength(2);
    expect(session.result.emailCollisionGroups).toEqual([
      {
        email: 'same@example.com',
        fingerprints: session.result.accounts.map((account) => account.fingerprint),
      },
    ]);
  });

  it('never runs more sources than the configured concurrency', async () => {
    let active = 0;
    let maxActive = 0;
    const makeDelayedSource = (
      id: LocalAccountDiscoverySource['id'],
    ): LocalAccountDiscoverySource =>
      createSource(id, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return {
          candidates: [],
          failures: [],
          inspectedLocations: 1,
        };
      });
    const service = new LocalAccountDiscoveryService({
      digestKey: Buffer.alloc(32, 10),
      maxConcurrency: 2,
      sources: [
        makeDelayedSource('antigravity-keyring'),
        makeDelayedSource('antigravity-classic-db'),
        makeDelayedSource('antigravity-ide-db'),
        makeDelayedSource('legacy-agent'),
      ],
    });

    await service.discover();

    expect(maxActive).toBe(2);
  });
});
