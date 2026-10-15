import { shell } from 'electron';
import { setTimeout as delay } from 'node:timers/promises';
import { ManagementClient, OAuthManagementError } from '@/core/management/client';
import { getManagementEndpoint } from '@/core/management/endpoint';
import type { CoreRpcClient } from '@/core/rpc/client';
import {
  CloudAccountViewSchema,
  type CloudAccountView,
} from '@/modules/cloud-account/services/cloud-account-view';
import { DesktopOAuthLoginError } from '@/modules/cloud-account/services/desktop-oauth-login.error';
import {
  GoogleLoginOperation,
  GoogleLoginStepError,
} from '@/modules/cloud-account/services/google-login-operation';
import type { HeadlessOAuthStatus } from '@/modules/cloud-account/services/headless-oauth-session.service';
import { normalizeTrustedGoogleValidationUrl } from '@/modules/cloud-account/utils/google-validation-url';

interface RemoteOAuthManagement {
  startOAuth(
    oauthClientKey?: string,
    diagnosticId?: string,
  ): Promise<{ sessionId: string; authorizationUrl: string; diagnosticId: string }>;
  oauthStatus(sessionId: string): Promise<HeadlessOAuthStatus>;
  cancelOAuth(sessionId: string): Promise<void>;
  completeOAuth(sessionId: string, code: string): Promise<void>;
}

interface StandaloneCoreOAuthLoginDependencies {
  management: RemoteOAuthManagement;
  setPreference(clientKey: string): Promise<void>;
  accountViews(): Promise<CloudAccountView[]>;
  openExternal(url: string): Promise<void>;
}

/** Electron opens the browser; the standalone core owns callback and enrollment. */
export class StandaloneCoreOAuthLogin {
  private pending: Promise<CloudAccountView> | null = null;
  private sessionId: string | null = null;
  private stopping = false;

  async submitCode(code: string): Promise<void> {
    const operation = new GoogleLoginOperation();
    operation.enter('authorization');
    const sessionId = this.sessionId;
    if (!sessionId || this.stopping) {
      throw new DesktopOAuthLoginError(
        'login-failed',
        operation.finish(undefined, 'unavailable', true),
      );
    }
    operation.accountCommit = 'uncertain';
    try {
      await operation.run(
        'management-transport',
        () => this.dependencies.management.completeOAuth(sessionId, code),
        'management-failed',
      );
    } catch (error) {
      const cause = error instanceof GoogleLoginStepError ? error.cause : error;
      const expected =
        cause instanceof OAuthManagementError &&
        ['UNKNOWN_SESSION', 'INVALID_REQUEST'].includes(cause.code);
      throw new DesktopOAuthLoginError(
        'login-failed',
        operation.finish(error, undefined, expected),
      );
    }
  }

  constructor(private readonly dependencies: StandaloneCoreOAuthLoginDependencies) {}

  async start(oauthClientKey?: string): Promise<CloudAccountView> {
    const operation = new GoogleLoginOperation();
    if (this.stopping) {
      throw new DesktopOAuthLoginError(
        'login-cancelled',
        operation.finish(undefined, 'cancelled', true),
      );
    }
    if (this.pending) {
      throw new DesktopOAuthLoginError(
        'login-active',
        operation.finish(undefined, 'login-active', true),
      );
    }
    const pending = this.run(operation, oauthClientKey);
    this.pending = pending;
    pending.then(
      () => this.clearPending(pending),
      () => this.clearPending(pending),
    );
    return pending;
  }

  private clearPending(pending: Promise<CloudAccountView>): void {
    if (this.pending === pending) {
      this.pending = null;
    }
  }

  private async run(
    operation: GoogleLoginOperation,
    oauthClientKey?: string,
  ): Promise<CloudAccountView> {
    let ownerFinished = false;
    try {
      if (oauthClientKey) {
        await operation.run('client-selection', () =>
          this.dependencies.setPreference(oauthClientKey),
        );
      }
      if (this.stopping) {
        throw new DesktopOAuthLoginError('login-cancelled');
      }
      const started = await operation.run(
        'management-transport',
        () =>
          this.dependencies.management.startOAuth(oauthClientKey, operation.context.diagnosticId),
        'management-failed',
      );
      if (started.diagnosticId !== operation.context.diagnosticId) {
        throw new Error('OAuth operation identity does not match the owner');
      }
      this.sessionId = started.sessionId;
      if (this.stopping) {
        throw new DesktopOAuthLoginError('login-cancelled');
      }
      operation.enter('authorization-url');
      const authorizationUrl = normalizeTrustedGoogleValidationUrl(started.authorizationUrl);
      if (!authorizationUrl) {
        throw new DesktopOAuthLoginError('login-failed');
      }
      try {
        await operation.run('browser-open', () => this.dependencies.openExternal(authorizationUrl));
      } catch (error) {
        throw new DesktopOAuthLoginError('browser-open-failed', operation.finish(error));
      }
      // Once authorization is available, a transport loss cannot establish whether the owner persisted it.
      operation.accountCommit = 'uncertain';
      while (!this.stopping) {
        const status = await operation.run(
          'management-transport',
          () => this.dependencies.management.oauthStatus(started.sessionId),
          'management-failed',
        );
        if (status.state === 'failed') {
          ownerFinished = true;
          if (status.diagnostic.diagnosticId !== operation.context.diagnosticId) {
            throw new Error('OAuth failure identity does not match the owner');
          }
          throw new DesktopOAuthLoginError(status.loginCode, status.diagnostic);
        }
        if (status.state === 'succeeded') {
          ownerFinished = true;
          operation.accountCommit = 'confirmed';
          const accounts = await operation.run(
            'view-load',
            this.dependencies.accountViews,
            'storage-failed',
          );
          const account = accounts.find((entry) => entry.id === status.account.id);
          if (account && !this.stopping) {
            return CloudAccountViewSchema.parse(account);
          }
          throw new DesktopOAuthLoginError(this.stopping ? 'login-cancelled' : 'login-failed');
        }
        await delay(150);
      }
      throw new DesktopOAuthLoginError('login-cancelled');
    } catch (error) {
      if (!ownerFinished) {
        await this.cancelPendingSession();
      }
      if (error instanceof DesktopOAuthLoginError && error.diagnostic) {
        throw error;
      }
      if (
        error instanceof OAuthManagementError &&
        error.diagnostic &&
        error.diagnostic.diagnosticId !== operation.context.diagnosticId
      ) {
        throw new DesktopOAuthLoginError(
          'login-failed',
          operation.finish(undefined, 'management-failed'),
        );
      }
      const loginCode = this.stopping
        ? 'login-cancelled'
        : error instanceof DesktopOAuthLoginError
          ? error.loginCode
          : error instanceof OAuthManagementError && error.code === 'LOGIN_ACTIVE'
            ? 'login-active'
            : error instanceof OAuthManagementError && error.code === 'PROXY_CONFIGURATION_INVALID'
              ? 'proxy-configuration-invalid'
              : 'login-failed';
      throw new DesktopOAuthLoginError(
        loginCode,
        error instanceof OAuthManagementError && error.diagnostic
          ? error.diagnostic
          : operation.finish(
              error,
              loginCode === 'login-cancelled' ? 'cancelled' : undefined,
              loginCode === 'login-cancelled' || loginCode === 'login-active',
            ),
      );
    } finally {
      this.sessionId = null;
    }
  }

  private async cancelPendingSession(): Promise<void> {
    const sessionId = this.sessionId;
    if (sessionId) {
      await this.dependencies.management.cancelOAuth(sessionId).catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.cancelPendingSession();
    await this.pending?.catch(() => undefined);
  }
}

export function createStandaloneCoreOAuthLogin(
  client: Pick<CoreRpcClient, 'setActiveOAuthClient' | 'accountViews'>,
  management: RemoteOAuthManagement = new ManagementClient(getManagementEndpoint()),
): StandaloneCoreOAuthLogin {
  return new StandaloneCoreOAuthLogin({
    management,
    setPreference: (clientKey) => client.setActiveOAuthClient(clientKey),
    accountViews: () => client.accountViews(),
    openExternal: (url) => shell.openExternal(url),
  });
}
