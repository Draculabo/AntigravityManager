import type { CloudAccountView } from '../services/cloud-account-view';
import { DesktopOAuthLoginError } from '../services/desktop-oauth-login.error';
import type { DesktopOAuthSessionInput } from '../services/desktop-oauth-login.schema';
import { GoogleLoginOperation } from '../services/google-login-operation';

export interface PreparedDesktopOAuthOperations {
  prepare(oauthClientKey?: string): Promise<DesktopOAuthSessionInput>;
  open(sessionId: string): Promise<void>;
  copy(sessionId: string): Promise<void>;
  wait(sessionId: string): Promise<CloudAccountView>;
  submit(sessionId: string, code: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
}

export type RevealPreparedOAuthSession = (session: {
  sessionId: string;
  authorizationUrl: string;
}) => void;

interface PreparedAttempt {
  sessionId: string;
  authorizationUrl: string | null;
  result: Promise<CloudAccountView>;
}

export class PreparedDesktopOAuth implements PreparedDesktopOAuthOperations {
  private attempt: PreparedAttempt | null = null;

  constructor(
    private readonly begin: (
      key: string | undefined,
      reveal: RevealPreparedOAuthSession,
    ) => Promise<CloudAccountView>,
    private readonly openExternal: (url: string) => Promise<void>,
    private readonly writeClipboard: (url: string) => void,
    private readonly submitCode: (sessionId: string, code: string) => void | Promise<void>,
    private readonly cancelSession: (sessionId: string) => Promise<void>,
  ) {}

  prepare(oauthClientKey?: string): Promise<DesktopOAuthSessionInput> {
    const ready = Promise.withResolvers<DesktopOAuthSessionInput>();
    const result = Promise.resolve().then(() =>
      this.begin(oauthClientKey, (session) => {
        const attempt: PreparedAttempt = { ...session, result };
        this.attempt = attempt;
        const forgetLink = () => {
          attempt.authorizationUrl = null;
        };
        result.then(forgetLink, forgetLink);
        ready.resolve({ sessionId: session.sessionId });
      }),
    );
    result.catch(ready.reject);
    return ready.promise;
  }

  async open(sessionId: string): Promise<void> {
    const url = this.activeUrl(sessionId);
    const operation = new GoogleLoginOperation();
    try {
      await operation.run('browser-open', () => this.openExternal(url));
    } catch (error) {
      throw new DesktopOAuthLoginError('browser-open-failed', operation.finish(error));
    }
  }

  async copy(sessionId: string): Promise<void> {
    this.writeClipboard(this.activeUrl(sessionId));
  }

  async wait(sessionId: string): Promise<CloudAccountView> {
    const attempt = this.find(sessionId);
    if (!attempt) {
      throw new DesktopOAuthLoginError('login-cancelled');
    }
    return attempt.result;
  }

  async submit(sessionId: string, code: string): Promise<void> {
    this.activeUrl(sessionId);
    await this.submitCode(sessionId, code);
  }

  async cancel(sessionId: string): Promise<void> {
    const attempt = this.find(sessionId);
    if (!attempt?.authorizationUrl) {
      return;
    }
    await this.cancelSession(sessionId);
    await attempt.result.catch(() => undefined);
  }

  private find(sessionId: string): PreparedAttempt | null {
    return this.attempt?.sessionId === sessionId ? this.attempt : null;
  }

  private activeUrl(sessionId: string): string {
    const url = this.find(sessionId)?.authorizationUrl;
    if (!url) {
      throw new DesktopOAuthLoginError('login-cancelled');
    }
    return url;
  }
}
