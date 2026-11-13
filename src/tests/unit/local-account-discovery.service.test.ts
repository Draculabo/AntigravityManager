import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { LocalAccountDiscoveryService } from '@/modules/cloud-account/local-import/local-account-discovery.service';
import { AntigravityAgyFileDiscoverySource } from '@/modules/cloud-account/local-import/sources/antigravity-agy-file.source';
import type {
  LocalAccountDiscoverySource,
  LocalAccountSourceResult,
} from '@/modules/cloud-account/local-import/types';

async function createAgyFixture() {
  const temporaryRoot = path.resolve(os.tmpdir());
  const home = await fs.mkdtemp(path.join(temporaryRoot, 'agm-agy-discovery-'));
  if (path.dirname(home) !== temporaryRoot) {
    throw new Error('Fixture home escaped the temporary root');
  }
  onTestFinished(() => fs.rm(home, { recursive: true, force: true }));
  const directory = path.join(home, '.gemini', 'antigravity-cli');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(home, '.gemini', 'oauth_creds.json'),
    '{"refresh_token":"synthetic-unrelated-oauth"}',
  );
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  return {
    agyFile: path.join(directory, 'antigravity-oauth-token'),
    readFile: vi.spyOn(fs, 'readFile'),
  };
}

afterEach(() => vi.restoreAllMocks());

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
    const agyIdToken = 'synthetic-agy-id';
    const { agyFile, readFile } = await createAgyFixture();
    await fs.writeFile(
      agyFile,
      JSON.stringify({ token: { refresh_token: refreshToken }, id_token: agyIdToken }),
    );
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
        new AntigravityAgyFileDiscoverySource(),
      ],
    });

    const session = await service.discover();

    expect(session.result.accounts).toHaveLength(1);
    expect(session.result.duplicateCount).toBe(3);
    expect(session.result.accounts[0]).toMatchObject({
      emailHints: ['user@example.com'],
      hasAccessToken: true,
      hasIdToken: true,
      projectId: 'project-from-db',
      sources: [
        { id: 'antigravity-keyring' },
        { id: 'antigravity-classic-db', location: 'classic-state.vscdb' },
        { id: 'legacy-agent', location: 'legacy-account.json' },
        { id: 'antigravity-agy-file' },
      ],
    });

    const fingerprint = session.result.accounts[0].fingerprint;
    expect(session.getCredential(fingerprint)).toEqual({
      accessToken,
      refreshToken,
      idToken: agyIdToken,
      projectId: 'project-from-db',
      expiryTimestamp: 1_800_000_000,
    });

    const serializedResult = JSON.stringify(session.result);
    expect(serializedResult).not.toContain(refreshToken);
    expect(serializedResult).not.toContain(accessToken);
    expect(serializedResult).not.toContain(agyIdToken);
    const serializedSession = JSON.stringify(session);
    expect(serializedSession).not.toContain(refreshToken);
    expect(serializedSession).not.toContain(accessToken);
    expect(serializedSession).not.toContain(agyIdToken);
    expect(readFile).toHaveBeenCalledExactlyOnceWith(agyFile, 'utf8');
  });

  it.each([
    {
      file: 'missing',
      code: null,
      payload: null,
    },
    {
      file: 'invalid JSON',
      code: 'malformed',
      payload: '{',
    },
    {
      file: 'missing refresh token',
      code: 'malformed',
      payload: '{"access_token":"synthetic-access","refresh_token":" "}',
    },
    {
      file: 'permission denied',
      code: 'permission-denied',
      payload: null,
      error: Object.assign(new Error('Permission denied for synthetic private value'), {
        code: 'EACCES',
      }),
    },
  ])(
    'returns no candidate for a dedicated agy file with $file',
    async ({ code, payload, error }) => {
      const { agyFile, readFile } = await createAgyFixture();
      if (error) {
        readFile.mockRejectedValue(error);
      } else if (payload !== null) {
        await fs.writeFile(agyFile, payload);
      }

      const result = await new AntigravityAgyFileDiscoverySource().discover();
      expect(result).toEqual({
        candidates: [],
        failures: code
          ? [{ source: { id: 'antigravity-agy-file' }, code, message: expect.any(String) }]
          : [],
        inspectedLocations: 1,
      });
      expect(JSON.stringify(result)).not.toContain('synthetic');
      expect(readFile).toHaveBeenCalledExactlyOnceWith(agyFile, 'utf8');
    },
  );

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
