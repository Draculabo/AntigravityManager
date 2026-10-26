import { afterEach, describe, expect, it, vi } from 'vitest';

import { mockAxiosRequests, type MockHttpTransport } from '../helpers/mock-axios-request';

const PROD_LOAD_PROJECT = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
const DAILY_LOAD_PROJECT = 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
const SANDBOX_LOAD_PROJECT =
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist';

function projectContext(projectId: string) {
  return {
    json: async () => ({ cloudaicompanionProject: projectId }),
    status: 200,
  };
}

describe('GoogleAPIService project-context fallback policy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.useRealTimers();
  });

  it('tries daily-prod before sandbox after the production endpoint is rate limited', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ status: 429, text: async () => 'RESOURCE_EXHAUSTED' })
      .mockResolvedValueOnce(projectContext('daily-project'));
    mockAxiosRequests(transport as unknown as MockHttpTransport);
    const { GoogleAPIService } = await import('@/modules/cloud-account/services/GoogleAPIService');

    await expect(
      GoogleAPIService.fetchProjectId('access-token', 'http://127.0.0.1:8080'),
    ).resolves.toBe('daily-project');

    expect(transport.mock.calls.map(([url]) => url)).toEqual([
      PROD_LOAD_PROJECT,
      DAILY_LOAD_PROJECT,
    ]);
    for (const [, options] of transport.mock.calls) {
      expect(options.headers).not.toHaveProperty('X-Goog-Api-Client');
      expect(options.headers).not.toHaveProperty('x-activity-request-id');
    }
  });

  it('continues from daily-prod to sandbox for retryable HTTP failures', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ status: 404, text: async () => 'NOT_FOUND' })
      .mockResolvedValueOnce({ status: 503, text: async () => 'UNAVAILABLE' })
      .mockResolvedValueOnce(projectContext('sandbox-project'));
    mockAxiosRequests(transport);
    const { GoogleAPIService } = await import('@/modules/cloud-account/services/GoogleAPIService');

    await expect(
      GoogleAPIService.fetchProjectId('access-token', 'http://127.0.0.1:8080'),
    ).resolves.toBe('sandbox-project');

    expect(transport.mock.calls.map(([url]) => url)).toEqual([
      PROD_LOAD_PROJECT,
      DAILY_LOAD_PROJECT,
      SANDBOX_LOAD_PROJECT,
    ]);
  });

  it('continues to daily-prod after a transport failure', async () => {
    const observedAt = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(observedAt);
    const transport = vi
      .fn()
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(projectContext('daily-project'));
    mockAxiosRequests(transport);
    const { GoogleAPIService } = await import('@/modules/cloud-account/services/GoogleAPIService');

    const context = GoogleAPIService.fetchProjectContext('access-token', 'http://127.0.0.1:8080');
    await expect(context).resolves.toEqual({
      projectId: 'daily-project',
      subscriptionTier: 'free',
      subscription: {
        refresh_status: 'succeeded',
        checked_at: observedAt,
        observation: { status: 'missing', tier: 'free', source: 'none', observed_at: observedAt },
      },
    });
    expect(transport.mock.calls.map(([url]) => url)).toEqual([
      PROD_LOAD_PROJECT,
      DAILY_LOAD_PROJECT,
    ]);
  });

  it('shares one deadline across project endpoint attempts', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const transport = vi.fn(async () => {
      now += 30_001;
      throw new Error('first endpoint timed out');
    });
    mockAxiosRequests(transport);
    const { GoogleAPIService } = await import('@/modules/cloud-account/services/GoogleAPIService');

    const request = GoogleAPIService.fetchProjectContext('access-token', 'http://127.0.0.1:8080');
    await expect(request).rejects.toThrow(
      'Google API request deadline exceeded during project-context lookup',
    );

    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('shares the quota request deadline with its project-context lookup', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const transport = vi.fn(async () => {
      now += 30_001;
      return projectContext('project-1');
    });
    mockAxiosRequests(transport as unknown as MockHttpTransport);
    const { GoogleAPIService } = await import('@/modules/cloud-account/services/GoogleAPIService');

    await expect(GoogleAPIService.fetchQuota('access-token')).rejects.toThrow(
      'Google API request deadline exceeded during quota lookup',
    );
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each([400, 401, 403])('does not retry a permanent status %i', async (status) => {
    const transport = vi
      .fn()
      .mockResolvedValue({ status, text: async () => `AUTHENTICATION_${status}` });
    mockAxiosRequests(transport);
    const { GoogleAPIService } = await import('@/modules/cloud-account/services/GoogleAPIService');

    await expect(
      GoogleAPIService.fetchProjectId('access-token', 'http://127.0.0.1:8080'),
    ).rejects.toThrow(`HTTP ${status}`);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
