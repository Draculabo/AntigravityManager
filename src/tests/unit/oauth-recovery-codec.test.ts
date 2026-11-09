import { describe, expect, it } from 'vitest';
import {
  classifyOAuthRecovery,
  parseOAuthRecoveryRecord,
} from '@/modules/cloud-account/persistence/oauth-recovery-codec';

const record = {
  version: 1,
  accountId: 'account-1',
  expected: { access_token: 'old-access', refresh_token: 'old-refresh' },
  token: {
    access_token: 'new-access',
    refresh_token: 'new-refresh',
    expires_in: 3600,
    expiry_timestamp: 100,
    token_type: 'Bearer',
  },
};

describe('OAuth recovery record codec', () => {
  it('accepts a versioned recovery record', () => {
    expect(parseOAuthRecoveryRecord(JSON.stringify(record))).toEqual(record);
  });

  it('distinguishes recoverable, applied, replaced and deleted accounts', () => {
    const parsed = parseOAuthRecoveryRecord(JSON.stringify(record));
    const prior = { ...record.token, ...record.expected };
    expect(classifyOAuthRecovery(parsed, prior)).toBe('apply');
    expect(classifyOAuthRecovery(parsed, record.token)).toBe('applied');
    expect(classifyOAuthRecovery(parsed, { ...record.token, refresh_token: 'reauthorized' })).toBe(
      'conflict',
    );
    expect(classifyOAuthRecovery(parsed, undefined)).toBe('missing');
  });

  it('does not discard a record when unchanged credentials still need an expiry update', () => {
    const parsed = parseOAuthRecoveryRecord(
      JSON.stringify({
        ...record,
        token: {
          ...record.token,
          access_token: record.expected.access_token,
          refresh_token: record.expected.refresh_token,
        },
      }),
    );
    expect(classifyOAuthRecovery(parsed, { ...parsed.token, expiry_timestamp: 1 })).toBe('apply');
  });

  it.each([
    '{broken',
    JSON.stringify({ ...record, version: 2 }),
    JSON.stringify({ ...record, token: { ...record.token, refresh_token: '' } }),
    JSON.stringify({ ...record, unexpected: true }),
    'x'.repeat(262_145),
  ])('rejects malformed or unsupported input without disclosing it', (input) => {
    expect(() => parseOAuthRecoveryRecord(input)).toThrowError('Invalid OAuth recovery record');
  });
});
