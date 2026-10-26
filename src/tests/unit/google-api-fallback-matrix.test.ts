import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mockAxiosRequests,
  type MockHttpRequestOptions,
  type MockHttpTransport,
} from '../helpers/mock-axios-request';

const MAIN_QUOTA_ENDPOINTS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
  'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
  'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
];
const SUMMARY_ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary',
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
    'moves the primary quota request from Sandbox to the next endpoint after HTTP %i',
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

  it.each([429, 500, 502, 503, 504])(
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

  it.each([400, 401, 403, 404])(
    'preserves primary quota and stops summary traversal only on HTTP 401 (received %i)',
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
        ...(status === 401 ? [SUMMARY_ENDPOINTS[0]] : SUMMARY_ENDPOINTS),
      ]);
    },
  );
});
