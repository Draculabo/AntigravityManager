import { describe, expect, it, vi } from 'vitest';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { listCloudAccountSummaries } from '@/modules/cloud-account/services/cloud-account-summary.service';

describe('cloud account summary projection', () => {
  it('returns display fields without serializing account credentials', async () => {
    vi.spyOn(CloudAccountRepo, 'getAccounts').mockResolvedValueOnce([
      {
        id: '11111111-1111-4111-8111-111111111111',
        provider: 'google',
        email: 'example@example.com',
        name: 'Example',
        token: {
          access_token: 'secret-access',
          refresh_token: 'secret-refresh',
          expires_in: 3600,
          expiry_timestamp: 1000,
          token_type: 'Bearer',
        },
        quota: { models: { gemini: { percentage: 50, resetTime: 'later' } } },
        created_at: 1,
        last_used: 2,
      },
    ]);

    const summaries = await listCloudAccountSummaries();
    expect(summaries).toEqual([
      {
        id: '11111111-1111-4111-8111-111111111111',
        provider: 'google',
        email: 'example@example.com',
        name: 'Example',
        avatarUrl: null,
        status: null,
        lastUsed: 2,
        quota: { subscriptionTier: null, modelCount: 1 },
      },
    ]);
    expect(JSON.stringify(summaries)).not.toContain('secret-access');
    expect(JSON.stringify(summaries)).not.toContain('secret-refresh');
  });
});
