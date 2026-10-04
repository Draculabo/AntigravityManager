import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { readClientAccountToken, resolveClientAccountStorage } from '@/modules/antigravity-runtime';
import { getCurrentAccountInfo as readSqliteAccountInfo } from '@/modules/account/persistence/antigravity-state-database';
import { getCurrentAccountInfo } from '@/modules/account/services/current-account.service';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));
vi.mock('@/modules/antigravity-runtime', () => ({
  readClientAccountToken: vi.fn(),
  resolveClientAccountStorage: vi.fn(),
}));
vi.mock('@/modules/account/persistence/antigravity-state-database', () => ({
  getCurrentAccountInfo: vi.fn(),
}));

beforeEach(() => vi.resetAllMocks());

describe('current client identity', () => {
  it('reads the selected IDE database without consulting another client token', async () => {
    vi.mocked(resolveClientAccountStorage).mockResolvedValue('sqlite');
    vi.mocked(readSqliteAccountInfo).mockReturnValue({
      email: 'ide@example.com',
      isAuthenticated: true,
    });
    const options = { executablePath: '/opt/ide/antigravity' };
    expect(await getCurrentAccountInfo('ide', options)).toEqual({
      email: 'ide@example.com',
      isAuthenticated: true,
    });
    expect(readSqliteAccountInfo).toHaveBeenCalledWith('ide', options);
    expect(readClientAccountToken).not.toHaveBeenCalled();
  });

  it.each(['classic', 'agy'] as const)(
    'reads %s identity from that client session',
    async (target) => {
      vi.mocked(resolveClientAccountStorage).mockResolvedValue('credential-store');
      const profile = { email: 'selected@example.com', name: 'Selected' };
      vi.mocked(readClientAccountToken).mockResolvedValue({
        refreshToken: 'fixture-refresh',
        idToken: `header.${Buffer.from(JSON.stringify(profile)).toString('base64url')}.signature`,
      });
      expect(await getCurrentAccountInfo(target)).toEqual({ ...profile, isAuthenticated: true });
      expect(readClientAccountToken).toHaveBeenCalledWith(target);
      expect(axios.get).not.toHaveBeenCalled();
    },
  );

  it('returns signed out for a missing session', async () => {
    vi.mocked(resolveClientAccountStorage).mockResolvedValue('credential-store');
    vi.mocked(readClientAccountToken).mockResolvedValue(null);
    expect(await getCurrentAccountInfo('agy')).toEqual({ email: '', isAuthenticated: false });
  });

  it('uses the same stored access token when a session lacks identity claims', async () => {
    vi.mocked(resolveClientAccountStorage).mockResolvedValue('credential-store');
    vi.mocked(readClientAccountToken).mockResolvedValue({
      accessToken: 'fixture-access',
      refreshToken: 'fixture-refresh',
      idToken: 'malformed',
    });
    vi.mocked(axios.get).mockResolvedValue({
      data: { email: 'selected@example.com', name: 'Selected' },
    });
    expect(await getCurrentAccountInfo('agy')).toEqual({
      email: 'selected@example.com',
      name: 'Selected',
      isAuthenticated: true,
    });
    expect(axios.get).toHaveBeenCalledWith('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: 'Bearer fixture-access' },
      timeout: 10000,
    });
  });
});
