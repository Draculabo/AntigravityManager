import { describe, expect, it } from 'vitest';
import type { CloudAccount } from '@/modules/cloud-account/types';
import {
  CloudAccountViewSchema,
  projectCloudAccountView,
} from '@/modules/cloud-account/services/cloud-account-view';

describe('cloud account renderer view', () => {
  it('keeps account-card fields while excluding credentials and device state', () => {
    const account: CloudAccount & { future_secret: string } = {
      id: '11111111-1111-4111-8111-111111111111',
      provider: 'google',
      email: 'example@example.com',
      name: 'Example',
      avatar_url: 'https://example.com/avatar.png',
      token: {
        access_token: 'secret-access',
        refresh_token: 'secret-refresh',
        id_token: 'secret-id-token',
        expires_in: 3600,
        expiry_timestamp: 1000,
        token_type: 'Bearer',
      },
      quota: {
        models: {
          gemini: {
            percentage: 50,
            resetTime: 'later',
            display_name: 'Gemini',
            supports_images: true,
            max_tokens: 1024,
          },
        },
        model_forwarding_rules: { gemini: 'private-routing-target' },
        is_forbidden: true,
        isForbidden: true,
        subscription_tier: 'pro',
        ai_credits: { credits: 12.5, expiryDate: 'tomorrow' },
        quota_groups: [
          {
            display_name: 'Weekly',
            description: 'Weekly quota',
            buckets: [
              {
                bucket_id: 'weekly-model',
                window: 'weekly',
                remaining_fraction: 0.5,
                reset_time: 'tomorrow',
                display_name: 'Model',
                description: 'Model quota',
              },
            ],
          },
        ],
      },
      health: {
        validation: {
          status: 'requires_action',
          reason: 'VALIDATION_REQUIRED',
          detected_at_ms: 1,
          next_probe_at_ms: 2,
          verification_url: 'https://example.com/verify?code=secret-validation',
          description: 'secret-description',
        },
        oauth: { refresh_blocked: true, invalid_grant_count: 3 },
      },
      device_profile: {
        machineId: 'secret-machine',
        macMachineId: 'secret-mac',
        devDeviceId: 'secret-device',
        sqmId: 'secret-sqm',
      },
      device_history: [],
      proxy_url: 'http://secret-user:secret-password@127.0.0.1:7890',
      created_at: 1,
      last_used: 2,
      status: 'rate_limited',
      status_reason: 'rate limit: secret-provider-detail',
      is_active: true,
      is_active_ide: true,
      future_secret: 'secret-future',
    };

    const view = projectCloudAccountView(account);
    expect(view).toEqual({
      id: account.id,
      provider: 'google',
      email: 'example@example.com',
      name: 'Example',
      avatar_url: 'https://example.com/avatar.png',
      quota: {
        models: {
          gemini: { percentage: 50, resetTime: 'later', display_name: 'Gemini' },
        },
        subscription_tier: 'pro',
        ai_credits: { credits: 12.5, expiryDate: 'tomorrow' },
        quota_groups: [
          {
            display_name: 'Weekly',
            description: 'Weekly quota',
            buckets: [
              {
                bucket_id: 'weekly-model',
                window: 'weekly',
                remaining_fraction: 0.5,
                reset_time: 'tomorrow',
                display_name: 'Model',
                description: 'Model quota',
              },
            ],
          },
        ],
      },
      health: {
        validation: {
          status: 'requires_action',
          reason: 'VALIDATION_REQUIRED',
          has_verification_link: true,
        },
        oauth: { refresh_blocked: true },
      },
      created_at: 1,
      last_used: 2,
      status: 'rate_limited',
      status_reason: 'rate_limited',
      is_active: true,
      is_active_ide: true,
      proxy_configured: true,
    });
    const serialized = JSON.stringify(view);
    expect(serialized).not.toMatch(
      /secret-|access_token|refresh_token|id_token|device_profile|device_history|proxy_url|future_secret|verification_url|model_forwarding_rules|is_forbidden|isForbidden|supports_images|max_tokens/,
    );
    expect(CloudAccountViewSchema.safeParse({ ...view, token: account.token }).success).toBe(false);
    expect(
      CloudAccountViewSchema.safeParse({
        ...view,
        quota: { ...view.quota, model_forwarding_rules: { gemini: 'private-routing-target' } },
      }).success,
    ).toBe(false);
    expect(
      CloudAccountViewSchema.safeParse({
        ...view,
        quota: {
          ...view.quota,
          models: { gemini: { percentage: 50, resetTime: 'later', supports_images: true } },
        },
      }).success,
    ).toBe(false);
  });
});
