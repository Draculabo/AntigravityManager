import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ManagementServer } from '@/core/management/server';
import { ManagementClient } from '@/core/management/client';
import { StandaloneCoreOAuthLogin } from '@/modules/cloud-account/ipc/standalone-core-oauth-login';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ErrorReportingRuntime } from '@/shared/observability/errorReporting';
import { configureErrorReportingRuntime } from '@/shared/observability/errorReporting';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import { OAuthClientRegistryService } from '@/modules/cloud-account/services/OAuthClientRegistryService';
import { HeadlessOAuthSessionService } from '@/modules/cloud-account/services/headless-oauth-session.service';
import { DesktopOAuthLogin } from '@/modules/cloud-account/ipc/desktop-oauth-login';
import { enrollGoogleAccount } from '@/modules/cloud-account/services/google-account-enrollment.service';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { CloudAccountRefreshService } from '@/modules/cloud-account/services/CloudAccountRefreshService';
import { ConfigManager } from '@/modules/config/ipc/manager';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { prepareDesktopIdentityStorage } from '@/modules/identity-profile/public';
import { toDesktopOAuthLoginORPCError } from '@/modules/cloud-account/services/desktop-oauth-login.error';
import { parseDesktopOAuthLoginErrorData } from '@/modules/cloud-account/diagnostics';
import { toPublicORPCError } from '@/ipc/router';
import { getErrorDetailsText, getLocalizedErrorMessage } from '@/shared/utils/errorMessages';
import { buildErrorBugReport } from '@/modules/app-shell/bug-report';
import { logger } from '@/shared/logging/logger';
import { mockAxiosRequests } from '../helpers/mock-axios-request';
import { createGoogleProxyFixture } from '../helpers/google-proxy-fixture';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import i18next from 'i18next';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));
vi.mock('@/modules/identity-profile/public', () => ({
  prepareDesktopIdentityStorage: vi.fn(async () => undefined),
}));
vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    constructor() {
      throw new Error('Live credentials are forbidden');
    }
  },
}));
vi.mock('koffi', () => ({
  load() {
    throw new Error('Native credentials are forbidden');
  },
}));

const report = vi.fn<ErrorReportingRuntime['report']>(() => 'a'.repeat(32));
const sessions: HeadlessOAuthSessionService[] = [];
const servers: ManagementServer[] = [];
const directories: string[] = [];
const view: CloudAccountView = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'google',
  email: 'synthetic@example.invalid',
  created_at: 1,
  last_used: 1,
  proxy_configured: false,
};
beforeEach(() => {
  report.mockClear();
  configureErrorReportingRuntime({ initialize() {}, report, flush: async () => true }, true, true);
  vi.spyOn(ConfigManager, 'loadConfig').mockReturnValue(DEFAULT_APP_CONFIG);
  vi.spyOn(OAuthClientRegistryService, 'getCandidateClients').mockReturnValue([
    {
      key: 'synthetic',
      label: 'Synthetic',
      client_id: 'synthetic-id',
      client_secret: 'synthetic-secret',
      is_builtin: false,
    },
  ]);
  vi.spyOn(GoogleAPIService, 'getActiveOAuthClientKey').mockReturnValue('synthetic');
  vi.spyOn(GoogleAPIService, 'getAuthUrl').mockImplementation((_key, session) => {
    const url = new URL('https://accounts.google.com/');
    url.searchParams.set('redirect_uri', session.redirectUri);
    url.searchParams.set('state', session.state);
    return url.toString();
  });
  vi.spyOn(CloudAccountRepo, 'getAccountByEmail').mockResolvedValue(null);
  vi.spyOn(CloudAccountRepo, 'addAccount').mockResolvedValue();
  vi.spyOn(CloudAccountRepo, 'updateQuota').mockResolvedValue();
  vi.spyOn(CloudAccountRefreshService, 'clearFailureState').mockResolvedValue();
  vi.spyOn(GoogleAPIService, 'fetchQuota').mockResolvedValue({ models: {} });
  vi.spyOn(GoogleAPIService, 'fetchAICredits').mockResolvedValue(null);
  vi.mocked(prepareDesktopIdentityStorage).mockResolvedValue({});
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.stop()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
  configureErrorReportingRuntime(
    { initialize() {}, report() {}, flush: async () => true },
    false,
    false,
  );
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function failLogin(
  loadView: () => Promise<CloudAccountView | null> = async () => view,
  remote = false,
  denied = false,
) {
  const session = new HeadlessOAuthSessionService(enrollGoogleAccount);
  sessions.push(session);
  const openExternal = vi.fn(async (_url: string) => undefined);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-diagnostic-'));
  directories.push(directory);
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\agm-diagnostic-${randomUUID()}`
      : path.join(directory, 'core.sock');
  const server = new ManagementServer({
    endpoint,
    oauth: session,
    getStatus: () => ({ state: 'running', pid: 123, gateway: { running: false, port: null } }),
    shutdown: async () => {},
    onShutdownError: vi.fn(),
  });
  if (remote) {
    servers.push(server);
    await server.start();
  }
  const login = remote
    ? new StandaloneCoreOAuthLogin({
        management: new ManagementClient(endpoint),
        setPreference() {
          return Promise.resolve();
        },
        openExternal,
        accountViews: async () => {
          const account = await loadView();
          return account ? [account] : [];
        },
      })
    : new DesktopOAuthLogin({ session, selectClient() {}, openExternal, loadView });
  const pending = login.start().catch((error: unknown) => error);
  await vi.waitFor(() => expect(openExternal).toHaveBeenCalledOnce());
  const authorization = new URL(openExternal.mock.calls[0][0]);
  const callback = authorization.searchParams.get('redirect_uri');
  const state = authorization.searchParams.get('state');
  await new Promise<void>((resolve, reject) => {
    http
      .get(
        `${callback}?${denied ? 'error=access_denied' : 'code=synthetic-private-code'}&state=${state}`,
        (response) => {
          response.resume();
          response.once('end', resolve);
        },
      )
      .once('error', reject);
  });
  const failure = await pending;
  const envelope = toPublicORPCError(
    toDesktopOAuthLoginORPCError(failure),
    '["cloud","startGoogleAuthFlow"]',
  );
  const projected = parseDesktopOAuthLoginErrorData(envelope.data);
  if (!projected?.diagnostic) {
    throw new Error('Login diagnostic was lost at public IPC');
  }
  logger.error('Forwarded failed login', envelope);
  return { diagnostic: projected.diagnostic, envelope };
}

function successfulProviderResponses() {
  mockAxiosRequests(async (url) => ({
    status: 200,
    json: async () =>
      url.includes('/token')
        ? {
            access_token: 'synthetic-private-access',
            refresh_token: 'synthetic-private-refresh',
            expires_in: 3600,
            token_type: 'Bearer',
          }
        : { id: 'synthetic-google-id', email: view.email, verified_email: true },
  }));
}

describe('Google login diagnostic preservation', () => {
  it('retains generic user-info transport failures without guessing a network cause', async () => {
    mockAxiosRequests(async (url) => {
      if (url.includes('/token')) {
        return {
          status: 200,
          json: async () => ({
            access_token: 'synthetic-private-access',
            refresh_token: 'synthetic-private-refresh',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
        };
      }
      throw new Error('private-sentinel');
    });
    const { diagnostic } = await failLogin();
    expect(diagnostic.stage).toBe('user-info');
    expect(diagnostic.reason).toBe('network-failed');
    expect(diagnostic.nativeCode).toBeUndefined();
    expect(JSON.stringify(diagnostic)).not.toContain('private-sentinel');
    expect(report).toHaveBeenCalledOnce();
  });
  it('retains authorization denial without reporting an unexpected failure', async () => {
    const { diagnostic } = await failLogin(undefined, false, true);
    expect(diagnostic.stage).toBe('authorization');
    expect(diagnostic.reason).toBe('authorization-denied');
    expect(diagnostic.reporting).toEqual({ state: 'not-reported', reason: 'expected-outcome' });
    expect(report).not.toHaveBeenCalled();
    expect(CloudAccountRepo.addAccount).not.toHaveBeenCalled();
  });
  it('retains the duplicate-check stage without persisting or reporting the existing account', async () => {
    successfulProviderResponses();
    vi.mocked(CloudAccountRepo.getAccountByEmail).mockResolvedValueOnce({
      id: view.id,
      provider: 'google',
      email: view.email,
      created_at: 1,
      last_used: 1,
      token: {
        access_token: 'synthetic-private-access',
        refresh_token: 'synthetic-private-refresh',
        expires_in: 3600,
        expiry_timestamp: 1,
        token_type: 'Bearer',
      },
    });
    const { diagnostic } = await failLogin();
    expect(diagnostic.stage).toBe('duplicate-check');
    expect(diagnostic.reason).toBe('duplicate-account');
    expect(diagnostic.accountCommit).toBe('not-attempted');
    expect(diagnostic.reporting).toEqual({ state: 'not-reported', reason: 'expected-outcome' });
    expect(report).not.toHaveBeenCalled();
    expect(CloudAccountRepo.addAccount).not.toHaveBeenCalled();
    expect(prepareDesktopIdentityStorage).not.toHaveBeenCalled();
  });
  it('preserves user-info HTTP rejection as a distinct step', async () => {
    mockAxiosRequests(async (url) => ({
      status: url.includes('/token') ? 200 : 503,
      json: async () =>
        url.includes('/token')
          ? {
              access_token: 'synthetic-private-access',
              refresh_token: 'synthetic-private-refresh',
              expires_in: 3600,
              token_type: 'Bearer',
            }
          : { error_description: 'private-sentinel' },
    }));
    const { diagnostic } = await failLogin();
    expect(diagnostic.stage).toBe('user-info');
    expect(diagnostic.reason).toBe('http-rejected');
    expect(diagnostic.upstreamStatus).toBe(503);
    expect(diagnostic.accountCommit).toBe('not-attempted');
    expect(CloudAccountRepo.addAccount).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledOnce();
    expect(JSON.stringify(report.mock.calls)).not.toContain('private-sentinel');
  });
  it.each([
    ['config', 503],
    ['config', 502],
    ['account', 502],
    ['environment', 502],
    ['electron', 502],
  ] as const)(
    'preserves %s HTTP %s connection evidence through the real private endpoint',
    async (source, status) => {
      const fixture = await createGoogleProxyFixture(source, status);
      const { proxyUrl } = fixture;
      let result: Awaited<ReturnType<typeof failLogin>>;
      try {
        const refreshFailure = await GoogleAPIService.refreshAccessToken(
          'synthetic-private-refresh',
          source === 'account' ? proxyUrl : undefined,
        ).catch((error: unknown) => error);
        expect(fixture.counts()).toEqual({
          requests: 1,
          forwardedRequests: 0,
          authenticatedConnects: 1,
        });
        expect(refreshFailure).toMatchObject({
          classification: {
            reason: 'http-rejected',
            upstreamStatus: status,
            http: {
              route: 'https-connect',
              destination: 'loopback',
              transport: 'unknown',
              responseFormat: status === 502 ? 'html' : 'json',
            },
          },
        });
        if (source === 'account') {
          await expect(
            GoogleAPIService.getUserInfo('synthetic-private-access', proxyUrl),
          ).rejects.toMatchObject({
            classification: {
              reason: 'http-rejected',
              upstreamStatus: status,
              http: { route: 'https-connect' },
            },
          });
          return;
        }
        result = await failLogin(undefined, true);
      } finally {
        await fixture.close();
      }
      const { diagnostic, envelope } = result;
      expect(fixture.counts()).toEqual({
        requests: 2,
        forwardedRequests: 0,
        authenticatedConnects: 2,
      });
      expect(report).toHaveBeenCalledOnce();
      expect(diagnostic).toEqual({
        schemaVersion: 1,
        diagnosticId: report.mock.calls[0][0].operation?.failure.diagnosticId,
        operation: 'google-login',
        stage: 'token-exchange',
        reason: 'http-rejected',
        upstreamStatus: status,
        ...(status === 503 ? { upstreamCode: 'temporarily_unavailable' } : {}),
        http: {
          route: 'https-connect',
          destination: 'loopback',
          transport: 'unknown',
          responseFormat: status === 502 ? 'html' : 'json',
        },
        accountCommit: 'not-attempted',
        causes: [
          { reason: 'unknown' },
          {
            reason: 'http-rejected',
            upstreamStatus: status,
            ...(status === 503 ? { upstreamCode: 'temporarily_unavailable' } : {}),
            http: {
              route: 'https-connect',
              destination: 'loopback',
              transport: 'unknown',
              responseFormat: status === 502 ? 'html' : 'json',
            },
          },
        ],
        reporting: { state: 'captured', eventId: 'a'.repeat(32) },
      });
      expect(report.mock.calls[0][0].operation?.failure).toMatchObject({ http: diagnostic.http });
      expect(getErrorDetailsText(envelope)).toContain('HTTP connection evidence:');
      expect(JSON.stringify({ envelope, reports: report.mock.calls })).not.toContain(
        'private-sentinel',
      );
    },
  );
  it.each([
    [503, 'temporarily_unavailable'],
    [400, 'invalid_grant'],
  ] as const)(
    'retains HTTP %s from API exchange through enrollment, IPC, details and report',
    async (status, code) => {
      mockAxiosRequests(async () => ({
        status,
        json: async () => ({
          error: code,
          error_description: 'private-sentinel',
          access_token: 'private-sentinel',
        }),
      }));
      const { diagnostic, envelope } = await failLogin();
      expect(diagnostic).toEqual({
        schemaVersion: 1,
        diagnosticId: report.mock.calls[0][0].operation?.failure.diagnosticId,
        operation: 'google-login',
        stage: 'token-exchange',
        reason: 'http-rejected',
        upstreamStatus: status,
        upstreamCode: code,
        accountCommit: 'not-attempted',
        causes: [
          { reason: 'unknown' },
          { reason: 'http-rejected', upstreamStatus: status, upstreamCode: code },
        ],
        reporting: { state: 'captured', eventId: 'a'.repeat(32) },
      });
      expect(report).toHaveBeenCalledOnce();
      expect(CloudAccountRepo.addAccount).not.toHaveBeenCalled();
      const details = getErrorDetailsText(envelope);
      const body = buildErrorBugReport(
        {
          appVersion: '0.25.1',
          platform: 'win32',
          osVersion: 'Windows 11',
          architecture: 'x64',
          electronVersion: '37.10.3',
          nodeVersion: '22.21.1',
        },
        details,
      );
      for (const text of [
        JSON.stringify(envelope),
        JSON.stringify(report.mock.calls),
        details,
        body,
      ]) {
        expect(text).not.toMatch(
          /private-sentinel|synthetic-private-code|synthetic-secret|synthetic@example/,
        );
      }
      expect(body).toContain(diagnostic.diagnosticId);
      expect(body).toContain(`Upstream HTTP status: ${status}`);
      expect(body).toContain('delivery not confirmed');
    },
  );

  it('distinguishes DNS from a generic transport rejection without exposing the cause', async () => {
    mockAxiosRequests(async () => {
      throw Object.assign(new Error('private-sentinel'), { code: 'ENOTFOUND' });
    });
    const { diagnostic } = await failLogin();
    expect(diagnostic).toEqual({
      schemaVersion: 1,
      diagnosticId: report.mock.calls[0][0].operation?.failure.diagnosticId,
      operation: 'google-login',
      stage: 'token-exchange',
      reason: 'dns-failed',
      nativeCode: 'ENOTFOUND',
      accountCommit: 'not-attempted',
      causes: [
        { reason: 'unknown' },
        { reason: 'network-failed' },
        { reason: 'dns-failed', nativeCode: 'ENOTFOUND' },
      ],
      reporting: { state: 'captured', eventId: 'a'.repeat(32) },
    });
    expect(JSON.stringify(report.mock.calls)).not.toContain('private-sentinel');
    expect(report).toHaveBeenCalledOnce();
  });

  it('identifies malformed successful token data without forwarding its body', async () => {
    mockAxiosRequests(async () => ({
      status: 200,
      json: async () => ({ access_token: 'private-sentinel', expires_in: 'invalid' }),
    }));
    const { diagnostic } = await failLogin();
    expect(diagnostic.stage).toBe('token-exchange');
    expect(diagnostic.reason).toBe('malformed-response');
    expect(diagnostic.upstreamStatus).toBe(200);
    expect(JSON.stringify(report.mock.calls)).not.toContain('private-sentinel');
    expect(CloudAccountRepo.addAccount).not.toHaveBeenCalled();
  });

  it.each([
    ['identity-preparation', 'not-attempted'],
    ['account-persist', 'uncertain'],
    ['account-finalize', 'confirmed'],
    ['view-load', 'confirmed'],
  ] as const)('preserves persistence certainty for %s failure', async (stage, accountCommit) => {
    successfulProviderResponses();
    const error = Object.assign(new Error('private-sentinel'), { code: 'EIO' });
    if (stage === 'identity-preparation') {
      vi.mocked(prepareDesktopIdentityStorage).mockRejectedValueOnce(error);
    }
    if (stage === 'account-persist') {
      vi.mocked(CloudAccountRepo.addAccount).mockRejectedValueOnce(error);
    }
    if (stage === 'account-finalize') {
      vi.mocked(CloudAccountRefreshService.clearFailureState).mockRejectedValueOnce(error);
    }
    const { diagnostic, envelope } = await failLogin(async () => {
      if (stage === 'view-load') {
        throw error;
      }
      return view;
    });
    expect(diagnostic.stage).toBe(stage);
    expect(diagnostic.accountCommit).toBe(accountCommit);
    expect(diagnostic.reason).toBe('storage-failed');
    expect(diagnostic.nativeCode).toBe('EIO');
    expect(report).toHaveBeenCalledOnce();
    expect(JSON.stringify(envelope)).not.toContain('private-sentinel');
    if (accountCommit !== 'not-attempted') {
      const translator = i18next.createInstance();
      await translator.init({
        lng: 'en',
        resources: {
          en: {
            translation: {
              'operation-diagnostics': { 'check-account-list': 'Refresh the account list first' },
            },
          },
        },
      });
      expect(getLocalizedErrorMessage(envelope, translator.t)).toBe(
        'Refresh the account list first',
      );
    }
  });
});
