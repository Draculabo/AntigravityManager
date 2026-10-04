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
import {
  DesktopOAuthLoginError,
  oauthFailureCode,
} from '@/modules/cloud-account/services/desktop-oauth-login.error';

interface OAuthSessionClient {
  start(): ReturnType<HeadlessOAuthSessionService['start']>;
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
    if (this.stopping) {
      throw new DesktopOAuthLoginError('login-cancelled');
    }
    if (this.pending) {
      throw new DesktopOAuthLoginError('login-active');
    }
    const pending = this.run(oauthClientKey);
    this.pending = pending;
    const clearPending = () => {
      if (this.pending === pending) {
        this.pending = null;
      }
    };
    void pending.then(clearPending, clearPending);
    return pending;
  }

  private async run(oauthClientKey?: string): Promise<CloudAccountView> {
    let started: Awaited<ReturnType<OAuthSessionClient['start']>>;
    try {
      this.dependencies.selectClient(oauthClientKey);
      started = await this.dependencies.session.start();
    } catch (error) {
      throw new DesktopOAuthLoginError(
        this.stopping
          ? 'login-cancelled'
          : error instanceof OAuthLoginActiveError
            ? 'login-active'
            : 'login-failed',
      );
    }

    this.sessionId = started.sessionId;
    try {
      const authorizationUrl = normalizeTrustedGoogleValidationUrl(started.authorizationUrl);
      if (!authorizationUrl) {
        await this.dependencies.session.cancel(started.sessionId).catch(() => undefined);
        throw new DesktopOAuthLoginError('login-failed');
      }
      try {
        await this.dependencies.openExternal(authorizationUrl);
      } catch {
        await this.dependencies.session.cancel(started.sessionId).catch(() => undefined);
        throw new DesktopOAuthLoginError('browser-open-failed');
      }

      while (true) {
        const status = this.dependencies.session.status(started.sessionId);
        if (!status || this.stopping) {
          throw new DesktopOAuthLoginError('login-cancelled');
        }
        if (status.state === 'failed') {
          throw new DesktopOAuthLoginError(oauthFailureCode(status.message));
        }
        if (status.state === 'succeeded') {
          try {
            const view = await this.dependencies.loadView(status.account.id);
            if (view && !this.stopping) {
              return view;
            }
          } catch {
            // Persistence diagnostics remain in the owner process.
          }
          throw new DesktopOAuthLoginError(this.stopping ? 'login-cancelled' : 'login-failed');
        }
        await delay(150);
      }
    } finally {
      if (this.sessionId === started.sessionId) {
        this.sessionId = null;
      }
    }
  }

  submitCode(code: string): void {
    const sessionId = this.sessionId;
    if (!sessionId || !this.dependencies.session.completeCode(sessionId, code)) {
      throw new DesktopOAuthLoginError('login-failed');
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
