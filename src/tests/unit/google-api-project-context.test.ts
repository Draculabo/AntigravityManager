import { afterEach, describe, expect, it, vi } from 'vitest';

import { mockAxiosRequests } from '../helpers/mock-axios-request';

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
    mockAxiosRequests(transport);
    const { GoogleAPIService } = await import('@/modules/cloud-account/services/GoogleAPIService');

    await expect(
      GoogleAPIService.fetchProjectId('access-token', 'http://127.0.0.1:8080'),
    ).resolves.toBe('daily-project');

    expect(transport.mock.calls.map(([url]) => url)).toEqual([
      PROD_LOAD_PROJECT,
      DAILY_LOAD_PROJECT,
    ]);
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
    const transport = vi
      .fn()
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(projectContext('daily-project'));
    mockAxiosRequests(transport);
    const { GoogleAPIService } = await import('@/modules/cloud-account/services/GoogleAPIService');

    const context = GoogleAPIService.fetchProjectContext('access-token', 'http://127.0.0.1:8080');
    await expect(context).resolves.toEqual({ projectId: 'daily-project' });
    expect(transport.mock.calls.map(([url]) => url)).toEqual([
      PROD_LOAD_PROJECT,
      DAILY_LOAD_PROJECT,
    ]);
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
