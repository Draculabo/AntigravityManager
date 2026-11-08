import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mockAxiosRequests,
  type MockHttpRequestOptions,
  type MockHttpTransport,
} from '../helpers/mock-axios-request';

// This matrix owns traversal and payloads; the timeout suite owns elapsed retry budgets.
vi.mock('node:timers/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:timers/promises')>()),
  setTimeout: vi.fn(async () => undefined),
}));

const MAIN_QUOTA_ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
  'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
];
const SUMMARY_ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
];

function http(status: number, data: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(data),
    text: vi.fn().mockResolvedValue(JSON.stringify(data)),
  };
}

function mainQuotaResponse() {
  return http(200, {
    models: {
      'gemini-3-flash': {
        quotaInfo: { remainingFraction: 0.65, resetTime: '2026-05-05T00:00:00Z' },
      },
    },
  });
}

function summaryResponse() {
  return http(200, {
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          {
            bucketId: 'gemini-weekly',
            window: 'weekly',
            remainingFraction: 0.5,
            resetTime: '2026-05-12T00:00:00Z',
          },
        ],
      },
    ],
  });
}

async function loadGoogleApi(
  fetchMock: ReturnType<typeof vi.fn>,
  projectContext: { projectId?: string; subscriptionTier?: string } = {
    projectId: 'project-1',
    subscriptionTier: 'pro',
  },
) {
  mockAxiosRequests(fetchMock as unknown as MockHttpTransport);
  const { ConfigManager } = await import('@/modules/config/ipc/manager');
  vi.spyOn(ConfigManager, 'loadConfig').mockReturnValue({
    proxy: { upstream_proxy: { enabled: false } },
  } as never);
  const { GoogleAPIService } = await import('@/modules/cloud-account/services/GoogleAPIService');
  vi.spyOn(GoogleAPIService, 'fetchProjectContext').mockResolvedValue(projectContext);
  return GoogleAPIService;
}

describe('Google API project, quota and summary fallback matrix', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    for (const name of [
      'http_proxy',
      'HTTP_PROXY',
      'https_proxy',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'all_proxy',
      'NO_PROXY',
      'no_proxy',
      'npm_config_http_proxy',
      'npm_config_https_proxy',
      'npm_config_proxy',
      'npm_config_no_proxy',
      'ELECTRON_PROXY_SERVER',
    ]) {
      vi.stubEnv(name, '');
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it.each([429, 500, 502, 503, 504])(
    'moves the primary quota request from Daily to Sandbox after HTTP %i',
    async (status) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(http(status, { error: 'temporary upstream failure' }))
        .mockResolvedValueOnce(mainQuotaResponse())
        .mockResolvedValueOnce(http(401, { error: 'summary unavailable' }));
      const googleApi = await loadGoogleApi(fetchMock);
      const assertion = expect(googleApi.fetchQuota('access-token')).resolves.toMatchObject({
        models: { 'gemini-3-flash': { percentage: 65 } },
      });
      await assertion;

      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        MAIN_QUOTA_ENDPOINTS[0],
        MAIN_QUOTA_ENDPOINTS[1],
        SUMMARY_ENDPOINTS[0],
      ]);
    },
    // This first matrix also loads the cold configuration/module graph on Windows.
    15_000,
  );

  it('keeps primary quota data when the shared deadline expires during summary', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchMock = vi.fn(async (_url: string) => {
      if (_url.includes('retrieveUserQuotaSummary')) {
        now += 30_001;
        return summaryResponse();
      }
      return mainQuotaResponse();
    });
    const googleApi = await loadGoogleApi(fetchMock);

    const quota = await googleApi.fetchQuota('access-token');

    expect(quota.models).toMatchObject({ 'gemini-3-flash': { percentage: 65 } });
    expect(quota.quota_groups).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps one proxy snapshot across project, quota and summary requests', async () => {
    let proxyUrl = 'http://127.0.0.1:8080';
    const fetchMock = vi.fn(async (url: string, _options: MockHttpRequestOptions) => {
      if (url.includes('loadCodeAssist')) {
        proxyUrl = 'http://127.0.0.1:9090';
        return http(200, { cloudaicompanionProject: 'project-1' });
      }
      if (url.includes('fetchAvailableModels')) {
        return mainQuotaResponse();
      }
      return summaryResponse();
    });
    const googleApi = await loadGoogleApi(fetchMock);
    vi.mocked(googleApi.fetchProjectContext).mockRestore();
    const { ConfigManager } = await import('@/modules/config/ipc/manager');
    vi.mocked(ConfigManager.loadConfig).mockImplementation(
      () =>
        ({
          proxy: {
            upstream_proxy: {
              enabled: true,
              url: proxyUrl,
            },
          },
        }) as never,
    );

    await expect(googleApi.fetchQuota('access-token')).resolves.toMatchObject({
      quota_groups: [
        {
          display_name: 'Gemini Models',
        },
      ],
    });

    expect(
      fetchMock.mock.calls.map(([, options]) => {
        const agent = options.httpsAgent as { proxy?: URL } | undefined;
        return agent?.proxy?.port;
      }),
    ).toEqual(['8080', '8080', '8080']);
  });

  it.each([408, 429, 500, 502, 503, 504])(
    'tries the next summary endpoint after transient HTTP %i and keeps summary separate',
    async (status) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(mainQuotaResponse())
        .mockResolvedValueOnce(http(status, { error: 'temporary summary failure' }))
        .mockResolvedValueOnce(http(502, { error: 'temporary summary failure' }))
        .mockResolvedValueOnce(summaryResponse());
      const googleApi = await loadGoogleApi(fetchMock);

      await expect(googleApi.fetchQuota('access-token')).resolves.toMatchObject({
        models: { 'gemini-3-flash': { percentage: 65 } },
        quota_groups: [
          {
            display_name: 'Gemini Models',
            buckets: [{ bucket_id: 'gemini-weekly', window: 'weekly' }],
          },
        ],
      });

      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        MAIN_QUOTA_ENDPOINTS[0],
        SUMMARY_ENDPOINTS[0],
        SUMMARY_ENDPOINTS[1],
        SUMMARY_ENDPOINTS[2],
      ]);
    },
  );

  it.each([400, 401, 403, 404, 405, 409, 422, 499, 600])(
    'preserves primary quota and stops summary traversal on permanent HTTP %i',
    async (status) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(mainQuotaResponse())
        .mockResolvedValue(http(status, { error: 'permanent summary failure' }));
      const googleApi = await loadGoogleApi(fetchMock, {});

      await expect(googleApi.fetchQuota('access-token')).resolves.toMatchObject({
        models: { 'gemini-3-flash': { percentage: 65 } },
      });

      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        MAIN_QUOTA_ENDPOINTS[0],
        SUMMARY_ENDPOINTS[0],
      ]);
    },
  );

  it.each(['USER_PROJECT_DENIED', 'BILLING_DISABLED'])(
    'removes the identified project once after %s and preserves the downgrade across hosts',
    async (reason) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(mainQuotaResponse())
        .mockResolvedValueOnce(http(403, projectDenial(reason)))
        .mockResolvedValueOnce(http(503))
        .mockResolvedValueOnce(summaryResponse());
      const googleApi = await loadGoogleApi(fetchMock);

      const quota = await googleApi.fetchQuota('access-token');

      expect(quota.quota_groups?.[0]?.display_name).toBe('Gemini Models');
      expect(fetchMock.mock.calls.map(([url, options]) => [url, options.body])).toEqual([
        [MAIN_QUOTA_ENDPOINTS[0], JSON.stringify({ project: 'project-1' })],
        [SUMMARY_ENDPOINTS[0], JSON.stringify({ project: 'project-1' })],
        [SUMMARY_ENDPOINTS[0], JSON.stringify({})],
        [SUMMARY_ENDPOINTS[1], JSON.stringify({})],
      ]);
    },
  );

  it.each([
    ['unknown denial', { error: 'project permission denied' }],
    ['account permission', projectDenial('IAM_PERMISSION_DENIED')],
    ['other consumer', projectDenial('USER_PROJECT_DENIED', 'projects/other-project')],
    ['other domain', projectDenial('USER_PROJECT_DENIED', 'projects/project-1', 'other.example')],
  ])('does not remove project or advance after %s', async (_name, error) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mainQuotaResponse())
      .mockResolvedValueOnce(http(403, error))
      .mockResolvedValue(summaryResponse());
    const googleApi = await loadGoogleApi(fetchMock);

    const quota = await googleApi.fetchQuota('access-token');

    expect(quota.models['gemini-3-flash']?.percentage).toBe(65);
    expect(quota.quota_groups).toBeUndefined();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      MAIN_QUOTA_ENDPOINTS[0],
      SUMMARY_ENDPOINTS[0],
    ]);
  });

  it('keeps a primary-quota project downgrade through summary without granting another retry', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(http(403, projectDenial('USER_PROJECT_DENIED')))
      .mockResolvedValueOnce(mainQuotaResponse())
      .mockResolvedValueOnce(http(403, projectDenial('USER_PROJECT_DENIED')))
      .mockResolvedValue(summaryResponse());
    const googleApi = await loadGoogleApi(fetchMock);

    const quota = await googleApi.fetchQuota('access-token');

    expect(quota.models['gemini-3-flash']?.percentage).toBe(65);
    expect(quota.quota_groups).toBeUndefined();
    expect(fetchMock.mock.calls.map(([url, options]) => [url, options.body])).toEqual([
      [MAIN_QUOTA_ENDPOINTS[0], JSON.stringify({ project: 'project-1' })],
      [MAIN_QUOTA_ENDPOINTS[0], JSON.stringify({})],
      [SUMMARY_ENDPOINTS[0], JSON.stringify({})],
    ]);
  });

  it('rejects an unidentified primary quota denial without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(http(403, { error: 'permission denied' }));
    const googleApi = await loadGoogleApi(fetchMock);

    await expect(googleApi.fetchQuota('access-token')).rejects.toThrow('FORBIDDEN');

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([MAIN_QUOTA_ENDPOINTS[0]]);
  });

  it('does not restore the project after primary endpoint failover', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(http(403, projectDenial('USER_PROJECT_DENIED')))
      .mockResolvedValueOnce(http(503))
      .mockResolvedValueOnce(mainQuotaResponse())
      .mockResolvedValueOnce(summaryResponse());
    const googleApi = await loadGoogleApi(fetchMock);

    const quota = await googleApi.fetchQuota('access-token');

    expect(quota.quota_groups?.[0]?.display_name).toBe('Gemini Models');
    expect(fetchMock.mock.calls.map(([url, options]) => [url, options.body])).toEqual([
      [MAIN_QUOTA_ENDPOINTS[0], JSON.stringify({ project: 'project-1' })],
      [MAIN_QUOTA_ENDPOINTS[0], JSON.stringify({})],
      [MAIN_QUOTA_ENDPOINTS[1], JSON.stringify({})],
      [SUMMARY_ENDPOINTS[0], JSON.stringify({})],
    ]);
  });

  it('does not grant a second summary downgrade after the no-project retry is denied', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mainQuotaResponse())
      .mockResolvedValue(http(403, projectDenial('USER_PROJECT_DENIED')));
    const googleApi = await loadGoogleApi(fetchMock);

    const quota = await googleApi.fetchQuota('access-token');

    expect(quota.quota_groups).toBeUndefined();
    expect(fetchMock.mock.calls.map(([url, options]) => [url, options.body])).toEqual([
      [MAIN_QUOTA_ENDPOINTS[0], JSON.stringify({ project: 'project-1' })],
      [SUMMARY_ENDPOINTS[0], JSON.stringify({ project: 'project-1' })],
      [SUMMARY_ENDPOINTS[0], JSON.stringify({})],
    ]);
  });

  it('does not turn malformed successful summary data into a transport retry', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mainQuotaResponse())
      .mockResolvedValueOnce(http(200, { groups: 'invalid' }))
      .mockResolvedValue(summaryResponse());
    const googleApi = await loadGoogleApi(fetchMock);

    const quota = await googleApi.fetchQuota('access-token');

    expect(quota.models['gemini-3-flash']?.percentage).toBe(65);
    expect(quota.quota_groups).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('advances a failed summary transport without dropping the project', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mainQuotaResponse())
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(summaryResponse());
    const googleApi = await loadGoogleApi(fetchMock);

    const quota = await googleApi.fetchQuota('access-token');

    expect(quota.quota_groups?.[0]?.display_name).toBe('Gemini Models');
    expect(fetchMock.mock.calls.map(([url, options]) => [url, options.body])).toEqual([
      [MAIN_QUOTA_ENDPOINTS[0], JSON.stringify({ project: 'project-1' })],
      [SUMMARY_ENDPOINTS[0], JSON.stringify({ project: 'project-1' })],
      [SUMMARY_ENDPOINTS[1], JSON.stringify({ project: 'project-1' })],
    ]);
  });
});

function projectDenial(reason: string, consumer = 'projects/project-1', domain = 'googleapis.com') {
  return {
    error: {
      code: 403,
      status: 'PERMISSION_DENIED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason,
          domain,
          metadata: { consumer },
        },
      ],
    },
  };
}
