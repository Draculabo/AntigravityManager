import { describe, expect, it } from 'vitest';
import { prepareClientAccountCredentials } from '@/modules/antigravity-runtime/credentials/clientAccount';

describe('prepared client credentials', () => {
  const input = {
    email: 'user@example.com',
    name: 'User',
    token: { access_token: 'access', refresh_token: '', expiry_timestamp: 1 },
  };
  it('rejects an expired token without refresh credentials', () => {
    expect(() => prepareClientAccountCredentials(input)).toThrow(
      'expired token without a refresh token',
    );
  });
  it('accepts a still valid access-only token and detaches all credential metadata', () => {
    const account = {
      ...input,
      token: {
        ...input.token,
        expiry_timestamp: Math.floor(Date.now() / 1000) + 300,
        id_token: 'id',
        project_id: 'project',
      },
    };
    const prepared = prepareClientAccountCredentials(account);
    account.token.project_id = 'changed';
    expect(prepared).toEqual({ ...account, token: { ...account.token, project_id: 'project' } });
  });
  it('rejects a missing identity or invalid expiry before any process operation', () => {
    expect(() => prepareClientAccountCredentials({ ...input, email: '' })).toThrow('identity');
    expect(() =>
      prepareClientAccountCredentials({
        ...input,
        token: { ...input.token, expiry_timestamp: NaN },
      }),
    ).toThrow('expiry');
  });
});
