import { clipboard, shell } from 'electron';
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
import { PreparedDesktopOAuth, type RevealPreparedOAuthSession } from './prepared-desktop-oauth';

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
  writeClipboard?(url: string): void;
}

/** Electron opens the browser; the standalone core owns callback and enrollment. */
export class StandaloneCoreOAuthLogin {
  private pending: Promise<CloudAccountView> | null = null;
  private session: { id: string; mode: 'legacy' | 'prepared' } | null = null;
  private stopping = false;
  readonly prepared = new PreparedDesktopOAuth(
    (key, reveal) => this.begin(key, reveal),
    (url) => this.dependencies.openExternal(url),
    (url) =>
      this.dependencies.writeClipboard
        ? this.dependencies.writeClipboard(url)
        : clipboard.writeText(url),
    (sessionId, code) => this.submitCode(code, sessionId),
    (sessionId) => this.dependencies.management.cancelOAuth(sessionId),
  );

  async submitCode(code: string, expectedSessionId?: string): Promise<void> {
    const operation = new GoogleLoginOperation();
    operation.enter('authorization');
    const session = this.session;
    if (expectedSessionId && (session?.mode !== 'prepared' || session.id !== expectedSessionId)) {
      throw new DesktopOAuthLoginError('login-cancelled');
    }
    const sessionId = expectedSessionId ?? (session?.mode === 'legacy' ? session.id : null);
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
      if (cause instanceof OAuthManagementError && cause.code === 'INVALID_REQUEST') {
        operation.accountCommit = 'not-attempted';
        operation.enter('authorization');
        throw new DesktopOAuthLoginError(
          'invalid-manual-input',
          operation.finish(undefined, 'malformed-response', true),
        );
      }
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

  start(oauthClientKey?: string): Promise<CloudAccountView> {
    return this.begin(oauthClientKey);
  }

  private async begin(
    oauthClientKey?: string,
    reveal?: RevealPreparedOAuthSession,
  ): Promise<CloudAccountView> {
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
    const pending = this.run(operation, oauthClientKey, reveal);
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
    reveal?: RevealPreparedOAuthSession,
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
      this.session = { id: started.sessionId, mode: reveal ? 'prepared' : 'legacy' };
      if (this.stopping) {
        throw new DesktopOAuthLoginError('login-cancelled');
      }
      operation.enter('authorization-url');
      const authorizationUrl = normalizeTrustedGoogleValidationUrl(started.authorizationUrl);
      if (!authorizationUrl) {
        throw new DesktopOAuthLoginError('login-failed');
      }
      if (reveal) {
        reveal({ sessionId: started.sessionId, authorizationUrl });
      } else {
        try {
          await operation.run('browser-open', () =>
            this.dependencies.openExternal(authorizationUrl),
          );
        } catch (error) {
          throw new DesktopOAuthLoginError('browser-open-failed', operation.finish(error));
        }
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
      this.session = null;
    }
  }

  private async cancelPendingSession(): Promise<void> {
    const sessionId = this.session?.id;
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
