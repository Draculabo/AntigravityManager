import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isString } from 'lodash-es';

// Mock module to test timeout behavior
describe('GoogleAPIService Timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should abort request after timeout', async () => {
    const TIMEOUT_MS = 100;

    // Recreate the same logic used in GoogleAPIService
    const createTimeoutSignal = (ms: number): AbortSignal => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    };

    const signal = createTimeoutSignal(TIMEOUT_MS);

    // Verify signal is not aborted initially
    expect(signal.aborted).toBe(false);

    // Fast-forward time
    vi.advanceTimersByTime(TIMEOUT_MS + 10);

    // Signal should now be aborted
    expect(signal.aborted).toBe(true);
  });

  it('should set aborted state when controller.abort() is called', () => {
    const controller = new AbortController();

    // Initially not aborted
    expect(controller.signal.aborted).toBe(false);

    // Abort the controller
    controller.abort();

    // Signal should now be aborted
    expect(controller.signal.aborted).toBe(true);
  });

  it('should transform AbortError to user-friendly message', () => {
    // This tests our error transformation logic from GoogleAPIService
    const handleAbortError = (err: Error) => {
      if (err.name === 'AbortError') {
        throw new Error(
          'Token exchange timed out. Please check your network connection and try again.',
        );
      }
      throw err;
    };

    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';

    expect(() => handleAbortError(abortError)).toThrow(
      'Token exchange timed out. Please check your network connection and try again.',
    );
  });

  it('should not transform non-AbortError', () => {
    const handleAbortError = (err: Error) => {
      if (err.name === 'AbortError') {
        throw new Error(
          'Token exchange timed out. Please check your network connection and try again.',
        );
      }
      throw err;
    };

    const networkError = new Error('Network failure');
    networkError.name = 'NetworkError';

    expect(() => handleAbortError(networkError)).toThrow('Network failure');
  });
});

describe('GoogleAPIService OAuth clients', () => {
  const originalOauthClientsEnv = process.env.ANTIGRAVITY_OAUTH_CLIENTS;
  const originalActiveOauthClientEnv = process.env.ANTIGRAVITY_OAUTH_CLIENT_KEY;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.ANTIGRAVITY_OAUTH_CLIENTS;
    delete process.env.ANTIGRAVITY_OAUTH_CLIENT_KEY;
  });

  afterEach(() => {
    if (isString(originalOauthClientsEnv)) {
      process.env.ANTIGRAVITY_OAUTH_CLIENTS = originalOauthClientsEnv;
    } else {
      delete process.env.ANTIGRAVITY_OAUTH_CLIENTS;
    }

    if (isString(originalActiveOauthClientEnv)) {
      process.env.ANTIGRAVITY_OAUTH_CLIENT_KEY = originalActiveOauthClientEnv;
    } else {
      delete process.env.ANTIGRAVITY_OAUTH_CLIENT_KEY;
    }
  });

  it('loads builtin and custom oauth clients with active marker', async () => {
    process.env.ANTIGRAVITY_OAUTH_CLIENTS =
      'custom_a|id-a|secret-a|Custom A;custom_b|id-b|secret-b|Custom B';
    process.env.ANTIGRAVITY_OAUTH_CLIENT_KEY = 'custom_b';

    const { GoogleAPIService } = await import('../../services/GoogleAPIService');
    const clients = GoogleAPIService.listOAuthClients();

    expect(clients.find((client) => client.key === 'antigravity_enterprise')).toBeDefined();
    expect(clients.find((client) => client.key === 'custom_a')?.label).toBe('Custom A');
    expect(clients.find((client) => client.key === 'custom_b')?.is_active).toBe(true);
  });

  it('switches active oauth client key', async () => {
    process.env.ANTIGRAVITY_OAUTH_CLIENTS = 'custom_a|id-a|secret-a|Custom A';

    const { GoogleAPIService } = await import('../../services/GoogleAPIService');
    GoogleAPIService.setActiveOAuthClientKey('custom_a');

    expect(GoogleAPIService.getActiveOAuthClientKey()).toBe('custom_a');
  });

  it('throws when switching to unknown oauth client key', async () => {
    const { GoogleAPIService } = await import('../../services/GoogleAPIService');
    expect(() => GoogleAPIService.setActiveOAuthClientKey('missing_client')).toThrow(
      'Unknown OAuth client key',
    );
  });
});

describe('GoogleAPIService user info parsing', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('accepts Google user info responses without family_name', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        id: 'google-user-1',
        email: 'user@example.com',
        verified_email: true,
        name: 'Example User',
        given_name: 'Example',
        picture: 'https://example.com/avatar.png',
      }),
    });

    vi.stubGlobal('fetch', fetchMock);

    const { ConfigManager } = await import('../../ipc/config/manager');
    vi.spyOn(ConfigManager, 'loadConfig').mockReturnValue({
      proxy: {
        upstream_proxy: {
          enabled: false,
        },
      },
    } as any);

    const { GoogleAPIService } = await import('../../services/GoogleAPIService');

    await expect(GoogleAPIService.getUserInfo('access-token')).resolves.toEqual(
      expect.objectContaining({
        id: 'google-user-1',
        email: 'user@example.com',
        name: 'Example User',
        family_name: undefined,
      }),
    );
  });
});

describe('CloudAccountList auth code auto-submit guard', () => {
  it('returns true for a fresh auth code while the dialog is open', async () => {
    const { shouldAutoSubmitGoogleAuthCode } = await import('../../utils/googleAuthSubmission');

    expect(
      shouldAutoSubmitGoogleAuthCode({
        authCode: 'fresh-code',
        isAddDialogOpen: true,
        isPending: false,
        lastSubmittedAuthCode: null,
      }),
    ).toBe(true);
  });

  it('returns false after the same auth code was already auto-submitted', async () => {
    const { shouldAutoSubmitGoogleAuthCode } = await import('../../utils/googleAuthSubmission');

    expect(
      shouldAutoSubmitGoogleAuthCode({
        authCode: 'same-code',
        isAddDialogOpen: true,
        isPending: false,
        lastSubmittedAuthCode: 'same-code',
      }),
    ).toBe(false);
  });
});

describe('GoogleAPIService fetchQuota fallback policy', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('falls back to loadCodeAssist credits when fetchCredits returns 404', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: vi.fn().mockResolvedValue('NOT_FOUND'),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          paidTier: {
            availableCredits: [
              {
                creditType: 'GOOGLE_ONE_AI',
                creditAmount: '1000',
                minimumCreditAmountForUsage: '50',
              },
            ],
          },
        }),
      });

    vi.stubGlobal('fetch', fetchMock);

    const { ConfigManager } = await import('../../ipc/config/manager');
    vi.spyOn(ConfigManager, 'loadConfig').mockReturnValue({
      proxy: {
        upstream_proxy: {
          enabled: false,
        },
      },
    } as any);

    const { GoogleAPIService } = await import('../../services/GoogleAPIService');
    const { FALLBACK_VERSION, resolveLocalInstalledVersion } = await import(
      '../../server/modules/proxy/request-user-agent'
    );
    const expectedVersion = resolveLocalInstalledVersion() ?? FALLBACK_VERSION;

    await expect(GoogleAPIService.fetchAICredits('access-token')).resolves.toEqual({
      credits: 1000,
      expiryDate: '',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://cloudcode-pa.googleapis.com/v1internal:fetchCredits',
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
    );
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('POST');
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({
        metadata: {
          ide_type: 'ANTIGRAVITY',
          ide_version: expectedVersion,
          ide_name: 'antigravity',
        },
      }),
    );
  });

  it('does not fall through to the next endpoint on permanent 400 errors', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: vi.fn().mockResolvedValue('INVALID_ARGUMENT'),
      });

    vi.stubGlobal('fetch', fetchMock);

    const { ConfigManager } = await import('../../ipc/config/manager');
    vi.spyOn(ConfigManager, 'loadConfig').mockReturnValue({
      proxy: {
        upstream_proxy: {
          enabled: false,
        },
      },
    } as any);

    const { GoogleAPIService } = await import('../../services/GoogleAPIService');
    vi.spyOn(GoogleAPIService, 'fetchProjectContext').mockResolvedValue({
      projectId: 'project-1',
      subscriptionTier: 'free',
    });

    await expect(GoogleAPIService.fetchQuota('access-token')).rejects.toThrow(
      'HTTP 400 - INVALID_ARGUMENT',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses an explicit dispatcher from env proxy settings when no account proxy is provided', async () => {
    process.env.HTTP_PROXY = 'http://127.0.0.1:9090';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:9090';
    process.env.NO_PROXY = 'localhost,127.0.0.1,::1';

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: vi.fn().mockResolvedValue('BAD_GATEWAY'),
    });

    vi.stubGlobal('fetch', fetchMock);

    const { ConfigManager } = await import('../../ipc/config/manager');
    vi.spyOn(ConfigManager, 'loadConfig').mockReturnValue({
      proxy: {
        upstream_proxy: {
          enabled: false,
        },
      },
    } as any);

    const { GoogleAPIService } = await import('../../services/GoogleAPIService');

    await expect(GoogleAPIService.fetchAICredits('access-token')).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.dispatcher).toBeDefined();

    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.NO_PROXY;
  });

  it('uses electron proxy env as an explicit dispatcher fallback', async () => {
    process.env.ELECTRON_PROXY_SERVER = 'http://127.0.0.1:9090';

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: vi.fn().mockResolvedValue('BAD_GATEWAY'),
    });

    vi.stubGlobal('fetch', fetchMock);

    const { ConfigManager } = await import('../../ipc/config/manager');
    vi.spyOn(ConfigManager, 'loadConfig').mockReturnValue({
      proxy: {
        upstream_proxy: {
          enabled: false,
        },
      },
    } as any);

    const { GoogleAPIService } = await import('../../services/GoogleAPIService');

    await expect(GoogleAPIService.fetchAICredits('access-token')).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.dispatcher).toBeDefined();

    delete process.env.ELECTRON_PROXY_SERVER;
  });
});

describe('QuotaService fallback policy', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('does not fall through to the next endpoint on permanent 400 errors', async () => {
    const postMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        data: {
          cloudaicompanionProject: 'project-1',
          currentTier: { id: 'free' },
        },
      })
      .mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 400,
          data: { error: 'INVALID_ARGUMENT' },
        },
        message: 'Request failed with status code 400',
      });

    vi.doMock('axios', () => ({
      default: {
        create: vi.fn(() => ({
          post: postMock,
        })),
        isAxiosError: (error: unknown) => Boolean((error as { isAxiosError?: boolean })?.isAxiosError),
      },
      isAxiosError: (error: unknown) => Boolean((error as { isAxiosError?: boolean })?.isAxiosError),
    }));

    const { QuotaService } = await import('../../lib/antigravity/QuotaService');

    await expect(QuotaService.fetchQuota('access-token', 'user@example.com')).rejects.toThrow(
      'HTTP 400 - {"error":"INVALID_ARGUMENT"}',
    );
    expect(postMock).toHaveBeenCalledTimes(2);
  });
});
