import { shell } from 'electron';
import { setTimeout as delay } from 'node:timers/promises';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import {
  projectCloudAccountView,
  type CloudAccountView,
} from '@/modules/cloud-account/services/cloud-account-view';
import { enrollGoogleAccount } from '@/modules/cloud-account/services/google-account-enrollment.service';
import {
  HeadlessOAuthSessionService,
  OAuthLoginActiveError,
  type HeadlessOAuthStatus,
} from '@/modules/cloud-account/services/headless-oauth-session.service';
import {
  hydrateActiveOAuthClientFromSettings,
  setActiveOAuthClient,
} from '@/modules/cloud-account/services/cloud-account-oauth-settings.service';
import { normalizeTrustedGoogleValidationUrl } from '@/modules/cloud-account/utils/google-validation-url';
import { notifyTrayUpdate } from './quota-refresh-desktop';
import { DesktopOAuthLoginError } from '@/modules/cloud-account/services/desktop-oauth-login.error';
import { GoogleLoginOperation } from '@/modules/cloud-account/services/google-login-operation';
import { classifyOperationCause } from '@/modules/cloud-account/services/operation-cause';

interface OAuthSessionClient {
  start(
    clientKey?: string,
    operation?: GoogleLoginOperation,
  ): ReturnType<HeadlessOAuthSessionService['start']>;
  status(sessionId: string): HeadlessOAuthStatus | null;
  cancel(sessionId: string): Promise<void>;
  completeCode(sessionId: string, code: string): boolean;
  stop(): Promise<void>;
}

interface DesktopOAuthLoginDependencies {
  session: OAuthSessionClient;
  selectClient(clientKey?: string): void;
  openExternal(url: string): Promise<void>;
  loadView(accountId: string): Promise<CloudAccountView | null>;
}

/** Owns the full desktop login; authorization data never enters renderer IPC. */
export class DesktopOAuthLogin {
  private pending: Promise<CloudAccountView> | null = null;
  private sessionId: string | null = null;
  private stopping = false;

  constructor(private readonly dependencies: DesktopOAuthLoginDependencies) {}

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
    const clearPending = () => {
      if (this.pending === pending) {
        this.pending = null;
      }
    };
    void pending.then(clearPending, clearPending);
    return pending;
  }

  private async run(
    operation: GoogleLoginOperation,
    oauthClientKey?: string,
  ): Promise<CloudAccountView> {
    let started: Awaited<ReturnType<OAuthSessionClient['start']>> | undefined;
    try {
      await operation.run('client-selection', () => this.dependencies.selectClient(oauthClientKey));
      started = await this.dependencies.session.start(undefined, operation);
      this.sessionId = started.sessionId;
      operation.enter('authorization-url');
      const authorizationUrl = normalizeTrustedGoogleValidationUrl(started.authorizationUrl);
      if (!authorizationUrl) {
        const diagnostic = operation.finish(undefined, 'malformed-response');
        await this.dependencies.session.cancel(started.sessionId).catch(() => undefined);
        throw new DesktopOAuthLoginError('login-failed', diagnostic);
      }
      try {
        await operation.run('browser-open', () => this.dependencies.openExternal(authorizationUrl));
      } catch (error) {
        const diagnostic = operation.finish(error);
        await this.dependencies.session.cancel(started.sessionId).catch(() => undefined);
        throw new DesktopOAuthLoginError('browser-open-failed', diagnostic);
      }

      // A callback can start enrollment before the browser-open promise completes.
      if (operation.stage === 'browser-open') {
        operation.enter('authorization');
      }
      while (true) {
        const status = this.dependencies.session.status(started.sessionId);
        if (!status || this.stopping) {
          throw new DesktopOAuthLoginError('login-cancelled');
        }
        if (status.state === 'failed') {
          throw new DesktopOAuthLoginError(status.loginCode, status.diagnostic);
        }
        if (status.state === 'succeeded') {
          operation.accountCommit = 'confirmed';
          const view = await operation.run(
            'view-load',
            () => this.dependencies.loadView(status.account.id),
            'storage-failed',
          );
          if (view && !this.stopping) {
            return view;
          }
          throw new DesktopOAuthLoginError(this.stopping ? 'login-cancelled' : 'login-failed');
        }
        await delay(150);
      }
    } catch (error) {
      if (error instanceof DesktopOAuthLoginError && error.diagnostic) {
        throw error;
      }
      const loginCode = this.stopping
        ? 'login-cancelled'
        : error instanceof DesktopOAuthLoginError
          ? error.loginCode
          : error instanceof OAuthLoginActiveError
            ? 'login-active'
            : classifyOperationCause(error).primary.reason === 'proxy-configuration-invalid'
              ? 'proxy-configuration-invalid'
              : 'login-failed';
      throw new DesktopOAuthLoginError(
        loginCode,
        error instanceof OAuthLoginActiveError && error.diagnostic
          ? error.diagnostic
          : operation.finish(
              error,
              loginCode === 'login-cancelled' ? 'cancelled' : undefined,
              loginCode === 'login-active' || loginCode === 'login-cancelled',
            ),
      );
    } finally {
      if (started && this.sessionId === started.sessionId) {
        this.sessionId = null;
      }
    }
  }

  submitCode(code: string): void {
    const operation = new GoogleLoginOperation();
    operation.enter('authorization');
    const sessionId = this.sessionId;
    if (!sessionId || !this.dependencies.session.completeCode(sessionId, code)) {
      operation.accountCommit = sessionId ? 'uncertain' : 'not-attempted';
      throw new DesktopOAuthLoginError(
        'login-failed',
        operation.finish(undefined, 'unavailable', true),
      );
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.dependencies.session.stop();
    await this.pending?.catch(() => undefined);
  }
}

export const desktopOAuthLogin = new DesktopOAuthLogin({
  session: new HeadlessOAuthSessionService(
    async (code, options) => {
      const account = await enrollGoogleAccount(code, options);
      if (account.quota) {
        notifyTrayUpdate(account);
      }
      return account;
    },
    async () => {
      const { reloadNestServerAccountLeaseCache } = await import('@/server/main');
      return reloadNestServerAccountLeaseCache();
    },
  ),
  selectClient: (clientKey) => {
    if (clientKey) {
      setActiveOAuthClient(clientKey);
    } else {
      hydrateActiveOAuthClientFromSettings();
    }
  },
  openExternal: (url) => shell.openExternal(url),
  loadView: async (accountId) => {
    const account = await CloudAccountRepo.getAccount(accountId);
    return account ? projectCloudAccountView(account) : null;
  },
});
