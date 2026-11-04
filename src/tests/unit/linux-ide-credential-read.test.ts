// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readClientAccountToken } from '@/modules/antigravity-runtime/credentials/antigravityCredentialStore';
import { readLinuxIdeCredentialSnapshot } from '@/modules/antigravity-runtime/credentials/linuxIdeCredentialStore';

vi.mock('@/modules/antigravity-runtime/credentials/linuxIdeCredentialStore', () => ({
  readLinuxIdeCredentialSnapshot: vi.fn(),
}));
const platform = process.platform;
function entry(collection: string, access: string, refresh: string, expiry: number) {
  return {
    path: `/org/freedesktop/secrets/collection/${collection}/1`,
    contentType: 'text/plain',
    payload: Buffer.from(
      JSON.stringify({
        token: { access_token: access, refresh_token: refresh, expiry_timestamp: expiry },
      }),
    ).toString('base64'),
  };
}
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  vi.mocked(readLinuxIdeCredentialSnapshot).mockReset();
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
});
describe('Linux IDE account readback', () => {
  it('returns no account when every collection is empty', async () => {
    vi.mocked(readLinuxIdeCredentialSnapshot).mockResolvedValue([]);
    expect(await readClientAccountToken('ide')).toBeNull();
  });
  it('accepts a refreshed access token for the same account and selects the latest expiry', async () => {
    vi.mocked(readLinuxIdeCredentialSnapshot).mockResolvedValue([
      entry('default', 'old-access', 'same-refresh', 1700000000),
      entry('login', 'new-access', 'same-refresh', 1800000000),
    ]);
    expect(await readClientAccountToken('ide')).toEqual({
      accessToken: 'new-access',
      refreshToken: 'same-refresh',
      expiryTimestamp: 1800000000,
    });
  });
  it('rejects divergent account credentials across collections', async () => {
    vi.mocked(readLinuxIdeCredentialSnapshot).mockResolvedValue([
      entry('default', 'access-a', 'refresh-a', 1700000000),
      entry('login', 'access-b', 'refresh-b', 1800000000),
    ]);
    await expect(readClientAccountToken('ide')).rejects.toMatchObject({ code: 'malformed' });
  });
  it('rejects malformed stored credentials without returning their contents', async () => {
    vi.mocked(readLinuxIdeCredentialSnapshot).mockResolvedValue([
      {
        ...entry('login', 'access', 'refresh', 1800000000),
        payload: Buffer.from('synthetic-private-malformed-json').toString('base64'),
      },
    ]);
    await expect(readClientAccountToken('ide')).rejects.toMatchObject({
      code: 'malformed',
      message: 'The Antigravity credential payload is malformed.',
    });
  });
});
