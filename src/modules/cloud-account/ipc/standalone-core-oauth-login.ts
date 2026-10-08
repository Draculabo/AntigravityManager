import { shell } from 'electron';
import { setTimeout as delay } from 'node:timers/promises';
import { ManagementClient, OAuthManagementError } from '@/core/management/client';
import { getManagementEndpoint } from '@/core/management/endpoint';
import type { CoreRpcClient } from '@/core/rpc/client';
import {
  CloudAccountViewSchema,
  type CloudAccountView,
} from '@/modules/cloud-account/services/cloud-account-view';
import {
  DesktopOAuthLoginError,
  oauthFailureCode,
} from '@/modules/cloud-account/services/desktop-oauth-login.error';
import { normalizeTrustedGoogleValidationUrl } from '@/modules/cloud-account/utils/google-validation-url';

interface RemoteOAuthManagement {
  startOAuth(oauthClientKey?: string): Promise<{ sessionId: string; authorizationUrl: string }>;
  oauthStatus(
    sessionId: string,
  ): Promise<
    | { state: 'pending' }
    | { state: 'succeeded'; account: { id: string; email: string } }
    | { state: 'failed'; message: string }
  >;
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
    const sessionId = this.sessionId;
    if (!sessionId || this.stopping) {
      throw new DesktopOAuthLoginError('login-failed');
    }
    try {
      await this.dependencies.management.completeOAuth(sessionId, code);
    } catch {
      throw new DesktopOAuthLoginError('login-failed');
    }
  }

  constructor(private readonly dependencies: StandaloneCoreOAuthLoginDependencies) {}

  async start(oauthClientKey?: string): Promise<CloudAccountView> {
    if (this.stopping) {
      throw new DesktopOAuthLoginError('login-cancelled');
    }
    if (this.pending) {
      throw new DesktopOAuthLoginError('login-active');
    }
    const pending = this.run(oauthClientKey);
    this.pending = pending;
    void pending.then(
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

  private async run(oauthClientKey?: string): Promise<CloudAccountView> {
    let ownerFinished = false;
    try {
      if (oauthClientKey) {
        await this.dependencies.setPreference(oauthClientKey);
      }
      if (this.stopping) {
        throw new DesktopOAuthLoginError('login-cancelled');
      }
      const started = await this.dependencies.management.startOAuth(oauthClientKey);
      this.sessionId = started.sessionId;
      if (this.stopping) {
        throw new DesktopOAuthLoginError('login-cancelled');
      }
      const authorizationUrl = normalizeTrustedGoogleValidationUrl(started.authorizationUrl);
      if (!authorizationUrl) {
        throw new DesktopOAuthLoginError('login-failed');
      }
      try {
        await this.dependencies.openExternal(authorizationUrl);
      } catch {
        throw new DesktopOAuthLoginError('browser-open-failed');
      }
      while (!this.stopping) {
        const status = await this.dependencies.management.oauthStatus(started.sessionId);
        if (status.state === 'failed') {
          ownerFinished = true;
          throw new DesktopOAuthLoginError(oauthFailureCode(status.message));
        }
        if (status.state === 'succeeded') {
          ownerFinished = true;
          const accounts = await this.dependencies.accountViews();
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
      if (error instanceof DesktopOAuthLoginError) {
        throw error;
      }
      throw new DesktopOAuthLoginError(
        this.stopping
          ? 'login-cancelled'
          : error instanceof OAuthManagementError && error.code === 'LOGIN_ACTIVE'
            ? 'login-active'
            : error instanceof OAuthManagementError && error.code === 'PROXY_CONFIGURATION_INVALID'
              ? 'proxy-configuration-invalid'
              : 'login-failed',
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
