import { describe, expect, it } from 'vitest';

import { CloudAccountSchema } from '@/modules/cloud-account/types';

describe('Cloud account agy active state', () => {
  it('parses agy active state from account payloads', () => {
    const parsed = CloudAccountSchema.parse({
      id: 'account-1',
      provider: 'google',
      email: 'user@example.com',
      token: {
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: 3600,
        expiry_timestamp: 1700000000,
        token_type: 'Bearer',
      },
      created_at: 1700000000,
      last_used: 1700000000,
      is_active_agy: true,
    });

    expect(parsed.is_active_agy).toBe(true);
  });
});
