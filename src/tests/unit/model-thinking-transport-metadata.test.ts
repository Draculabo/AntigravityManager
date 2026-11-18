import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigManager } from '@/modules/config/ipc/manager';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import { CloudQuotaModelInfoSchema } from '@/modules/cloud-account/types';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { refreshAccountQuotaCore } from '@/modules/cloud-account/services/cloud-account-quota-refresh.service';
import { AccountLeaseModelPolicy } from '@/server/gateway/modules/account-lease/policies/account-lease-model.policy';
import type { AccountLeaseTokenData } from '@/server/gateway/modules/account-lease/interfaces/account-lease-token-types';
import { mockAxiosRequests } from '../helpers/mock-axios-request';

vi.mock('node:timers/promises', async (original) => ({
  ...(await original<typeof import('node:timers/promises')>()),
  setTimeout: vi.fn(async () => undefined),
}));

beforeEach(() => {
  vi.spyOn(ConfigManager, 'loadConfig').mockReturnValue(DEFAULT_APP_CONFIG);
  vi.spyOn(GoogleAPIService, 'fetchProjectContext').mockResolvedValue({
    projectId: 'synthetic-project',
  });
});

afterEach(() => vi.restoreAllMocks());

function installModelResponse(models: object) {
  return mockAxiosRequests(async (url) =>
    url.includes('retrieveUserQuotaSummary')
      ? { status: 403, json: async () => ({ error: 'Summary unavailable' }) }
      : { status: 200, json: async () => ({ models }) },
  );
}

function token(
  accountId: string,
  models: NonNullable<AccountLeaseTokenData['quota']>['models'],
): AccountLeaseTokenData {
  return {
    account_id: accountId,
    email: 'synthetic@example.invalid',
    access_token: 'synthetic-access',
    refresh_token: 'synthetic-refresh',
    token_type: 'Bearer',
    expires_in: 3600,
    expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
    model_quotas: {},
    model_limits: {},
    model_reset_times: {},
    model_forwarding_rules: {},
    quota: { models },
  };
}

describe('provider thinking metadata boundary', () => {
  it('retains the last stored quota snapshot after an unsupported discovery level', async () => {
    const stored: CloudAccount = {
      id: 'd09-discovery-rejection',
      provider: 'google',
      email: 'synthetic@example.invalid',
      token: {
        access_token: 'synthetic-access',
        refresh_token: 'synthetic-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
        expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
        project_id: 'synthetic-project',
      },
      created_at: 1,
      last_used: 1,
      status: 'active',
      quota: {
        models: {
          'gemini-4-argon-high': { percentage: 70, resetTime: '', thinking_level: 'high' },
        },
      },
    };
    const originalQuota = structuredClone(stored.quota);
    vi.spyOn(CloudAccountRepo, 'getAccount').mockResolvedValue(stored);
    const write = vi.spyOn(CloudAccountRepo, 'updateQuota').mockResolvedValue();
    installModelResponse({
      'gemini-4-argon-high': {
        quotaInfo: { remainingFraction: 1 },
        thinkingLevel: 'unknown-new-level',
      },
    });
    await expect(refreshAccountQuotaCore(stored.id)).rejects.toThrow('malformed quota response');
    expect(write).not.toHaveBeenCalled();
    expect(stored.quota).toEqual(originalQuota);
  });

  it.each([
    [1, 'low'],
    [2, 'medium'],
    [3, 'high'],
    ['1', 'low'],
    ['2', 'medium'],
    ['3', 'high'],
    [' LOW ', 'low'],
    ['Medium', 'medium'],
    ['HIGH', 'high'],
  ] as const)(
    'normalizes provider thinkingLevel %j and persists only its canonical form',
    async (raw, expected) => {
      installModelResponse({
        'gemini-4-argon-high': {
          quotaInfo: { remainingFraction: 0.75, resetTime: '2026-11-11T00:00:00Z' },
          thinkingLevel: raw,
          supportsThinking: true,
        },
      });
      const result = await GoogleAPIService.fetchQuota('synthetic-token');
      const persisted = CloudQuotaModelInfoSchema.parse(
        JSON.parse(JSON.stringify(result.models['gemini-4-argon-high'])),
      );
      expect(persisted).toEqual({
        percentage: 75,
        resetTime: '2026-11-11T00:00:00Z',
        supports_thinking: true,
        thinking_level: expected,
      });
    },
  );

  it.each([null, undefined])(
    'retains missing thinking metadata when the provider returns %j',
    async (raw) => {
      installModelResponse({
        'gemini-4-argon-high': { quotaInfo: { remainingFraction: 1 }, thinkingLevel: raw },
      });
      const result = await GoogleAPIService.fetchQuota('synthetic-token');
      expect(
        CloudQuotaModelInfoSchema.parse(
          JSON.parse(JSON.stringify(result.models['gemini-4-argon-high'])),
        ),
      ).toEqual({ percentage: 100, resetTime: '' });
    },
  );

  it.each(['ULTRA', 4, 1.5, true, {}])(
    'rejects unsupported provider level %j through the existing quota error owner',
    async (raw) => {
      const transport = installModelResponse({
        'gemini-4-argon-high': { quotaInfo: { remainingFraction: 1 }, thinkingLevel: raw },
      });
      await expect(GoogleAPIService.fetchQuota('synthetic-token')).rejects.toThrow(
        'malformed quota response',
      );
      expect(transport.mock.calls.map(([request]) => request.url)).toEqual([
        'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
        'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
        'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
      ]);
    },
  );
});

describe('account thinking transport', () => {
  it('resolves channel precedence for the selected account without increasing numeric caps', () => {
    const metadata = { percentage: 100, resetTime: '' };
    const cache = new Map([
      [
        'levels',
        token('levels', {
          'gemini-4-argon-high': {
            ...metadata,
            supports_thinking: true,
            thinking_level: 'high',
            thinking_budget: 8192,
          },
        }),
      ],
      [
        'disabled',
        token('disabled', {
          'gemini-4-argon-high': {
            ...metadata,
            supports_thinking: false,
            thinking_level: 'medium',
            thinking_budget: 16384,
          },
        }),
      ],
      [
        'adaptive',
        token('adaptive', { 'gemini-4-argon-high': { ...metadata, thinking_budget: -1 } }),
      ],
      ['fixed', token('fixed', { 'gemini-4-argon-high': { ...metadata, thinking_budget: 8192 } })],
      [
        'unknown',
        token('unknown', { 'gemini-4-argon-high': { ...metadata, supports_thinking: true } }),
      ],
    ]);
    const policy = new AccountLeaseModelPolicy({
      getTokenCache: () => cache,
      isModelBlocked: () => false,
      logger: { log: vi.fn() },
    });
    expect(
      ['levels', 'disabled', 'adaptive', 'fixed', 'unknown', 'missing'].map((id) =>
        policy.getModelThinkingTransportForAccount(id, 'models/gemini-4-argon-high'),
      ),
    ).toEqual([
      { kind: 'level', defaultLevel: 'high' },
      { kind: 'disabled' },
      { kind: 'budget', defaultBudget: -1 },
      { kind: 'budget', defaultBudget: 8192 },
      undefined,
      undefined,
    ]);
    expect(
      ['levels', 'adaptive', 'fixed'].map((id) =>
        policy.getModelThinkingBudgetForAccount(id, 'gemini-4-argon-high'),
      ),
    ).toEqual([8192, undefined, 8192]);
    expect(policy.getModelThinkingTransportForAccount('levels', 'unknown-model')).toBeUndefined();
  });
});
