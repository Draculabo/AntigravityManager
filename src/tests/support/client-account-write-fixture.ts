import fs from 'node:fs';
import { afterEach, beforeEach, vi } from 'vitest';
import { getAntigravityDbPaths } from '@/shared/platform/paths';
import { getAntigravityVersion } from '@/modules/antigravity-runtime/utils/antigravityVersion';
import type { ClientAccountCredentials } from '@/modules/antigravity-runtime';
import * as macCredentials from '@/modules/antigravity-runtime/credentials/macosCredentialStore';

const state = vi.hoisted(() => ({
  rows: new Map<string, string>(),
  backups: vi.fn(async (_path: string) => undefined),
  opens: vi.fn(),
  failKey: '',
  writeAgyCliToken: vi.fn(),
  writeGoogleOAuthCredentials: vi.fn(),
  prepareRecovery: vi.fn(async () => async () => undefined),
  writeStandalone: vi.fn(),
  prepareLinuxRecovery: vi.fn(async () => async () => undefined),
  writeLinuxPayload: vi.fn(async (_payload: string) => undefined),
  writeMacPayload: vi.fn((_payload: string) => undefined),
  writeStandalonePayload: vi.fn(),
}));
export { state };
vi.mock('@/modules/antigravity-runtime/credentials/linuxIdeRecovery', () => ({
  prepareLinuxIdeRecovery: state.prepareLinuxRecovery,
}));
vi.mock('@/modules/antigravity-runtime/credentials/linuxIdeCredentialStore', () => ({
  writeLinuxIdeCredentialPayload: state.writeLinuxPayload,
}));
vi.mock('@/modules/antigravity-runtime/credentials/windowsIdeRecovery', () => ({
  prepareWindowsIdeRecovery: state.prepareRecovery,
}));
vi.mock('@/modules/antigravity-runtime/credentials/ideStandaloneToken', () => ({
  validateIdeStandaloneDestination: vi.fn(),
  writeIdeStandaloneToken: state.writeStandalone,
  writeIdeStandaloneCredentialPayload: state.writeStandalonePayload,
}));
vi.mock('@/shared/platform/paths', () => ({
  getAntigravityDbPaths: vi.fn(() => ['/fixture/state.vscdb']),
}));
vi.mock('@/modules/antigravity-runtime/utils/antigravityVersion', () => ({
  getAntigravityVersion: vi.fn(async () => ({ shortVersion: '2.18.1', bundleVersion: '2.18.1' })),
  compareVersion: (left: string, right: string) => {
    const toParts = (version: string) => version.split('.').map(Number);
    const leftParts = toParts(left);
    const rightParts = toParts(right);
    for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
      const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
      if (difference !== 0) {
        return difference;
      }
    }
    return 0;
  },
  isCredentialStoreVersion: (version: { shortVersion: string }) =>
    Number(version.shortVersion.split('.')[0]) >= 2,
}));
vi.mock('@/modules/antigravity-runtime/credentials/antigravityCredentialStore', () => ({
  writeAntigravityCredentialStoreToken: vi.fn(),
  readAntigravityCredentialStoreToken: vi.fn(),
}));
vi.mock('@/modules/antigravity-runtime/credentials/agyCliTokenStore', () => ({
  writeAgyCliToken: state.writeAgyCliToken,
}));
vi.mock('@/modules/antigravity-runtime/credentials/googleOAuthCredentialStore', () => ({
  writeGoogleOAuthCredentials: state.writeGoogleOAuthCredentials,
}));
vi.mock('drizzle-orm', async (original) => ({
  ...(await original<typeof import('drizzle-orm')>()),
  eq: (_column: unknown, value: string) => ({ key: value }),
}));
vi.mock('@/shared/persistence/database/dbConnection', () => {
  const db = {
    select: () => ({
      from: () => ({
        where: (condition: { key: string }) => ({
          all: () =>
            state.rows.has(condition.key) ? [{ value: state.rows.get(condition.key) }] : [],
        }),
      }),
    }),
    insert: () => ({
      values: (row: { key: string; value: string }) => ({
        onConflictDoUpdate: () => ({
          run: () => {
            if (state.failKey === row.key) {
              throw new Error('write failed');
            }
            state.rows.set(row.key, row.value);
          },
        }),
      }),
    }),
    delete: () => ({
      where: (condition: { key: string }) => ({ run: () => state.rows.delete(condition.key) }),
    }),
  };
  return {
    openDrizzleConnection: (file: string) => {
      state.opens(file);
      return {
        raw: { close: vi.fn(), backup: state.backups, exec: vi.fn() },
        orm: {
          ...db,
          transaction: (write: (transaction: typeof db) => void) => {
            const before = new Map(state.rows);
            try {
              write(db);
            } catch (error) {
              state.rows = before;
              throw error;
            }
          },
        },
      };
    },
  };
});

export const credentials: ClientAccountCredentials = {
  email: 'fixture@example.org',
  name: 'Fixture',
  token: {
    access_token: 'access',
    refresh_token: 'refresh',
    expiry_timestamp: 1800000000,
    id_token: 'id-token',
    project_id: 'project-a',
    is_gcp_tos: true,
  },
};
const originalPlatform = process.platform;
beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
  vi.clearAllMocks();
  vi.spyOn(macCredentials, 'writeMacOSKeychainPayload').mockImplementation(state.writeMacPayload);
  vi.spyOn(macCredentials, 'syncMacOSIdeCredentialFiles').mockImplementation(
    state.writeStandalonePayload,
  );
  state.rows.clear();
  state.failKey = '';
  vi.spyOn(fs, 'existsSync').mockReturnValue(true);
  vi.spyOn(fs, 'accessSync').mockImplementation(() => undefined);
  vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
  vi.spyOn(fs, 'chmodSync').mockImplementation(() => undefined);
  vi.mocked(getAntigravityDbPaths).mockReturnValue(['/fixture/state.vscdb']);
  vi.mocked(getAntigravityVersion).mockResolvedValue({
    shortVersion: '2.5.5',
    bundleVersion: '2.5.5',
  });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
  vi.restoreAllMocks();
});
