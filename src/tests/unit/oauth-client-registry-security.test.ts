import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/shared/logging/logger', () => ({
  logger: mockLogger,
}));

const OAUTH_CLIENTS_ENV = 'ANTIGRAVITY_OAUTH_CLIENTS';
const ACTIVE_OAUTH_CLIENT_ENV = 'ANTIGRAVITY_OAUTH_CLIENT_KEY';

const originalOauthClients = process.env[OAUTH_CLIENTS_ENV];
const originalActiveOauthClient = process.env[ACTIVE_OAUTH_CLIENT_ENV];

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

describe('OAuth client registry logging', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env[ACTIVE_OAUTH_CLIENT_ENV];
  });

  afterEach(() => {
    restoreEnv(OAUTH_CLIENTS_ENV, originalOauthClients);
    restoreEnv(ACTIVE_OAUTH_CLIENT_ENV, originalActiveOauthClient);
  });

  it('does not log client secrets from incomplete OAuth client entries', async () => {
    const secret = 'custom-client-secret-value';
    process.env[OAUTH_CLIENTS_ENV] = `|client-id|${secret}|Custom Client`;

    const { OAuthClientRegistryService } =
      await import('@/modules/cloud-account/services/OAuthClientRegistryService');

    OAuthClientRegistryService.listOAuthClients();

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[OAuthClientRegistryService] Ignored incomplete OAuth client entry in ANTIGRAVITY_OAUTH_CLIENTS',
    );
    expect(mockLogger.warn.mock.calls.flat().join(' ')).not.toContain(secret);
  });
});
