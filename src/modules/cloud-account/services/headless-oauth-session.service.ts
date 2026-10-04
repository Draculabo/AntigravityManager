import crypto from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { GoogleAPIService } from './GoogleAPIService';
import {
  DuplicateGoogleAccountError,
  enrollGoogleAccount,
} from './google-account-enrollment.service';
import { logger } from '@/shared/logging/logger';

const LOOPBACK_HOST = '127.0.0.1';
const SESSION_TIMEOUT_MS = 5 * 60_000;

export class OAuthLoginActiveError extends Error {
  constructor() {
    super('An OAuth login is already in progress');
    this.name = 'OAuthLoginActiveError';
  }
}

export type HeadlessOAuthStatus =
  | { state: 'pending' }
  | { state: 'succeeded'; account: { id: string; email: string } }
  | { state: 'failed'; message: string };

interface OAuthSession {
  id: string;
  state: string;
  redirectUri: string;
  clientKey?: string;
  server: FastifyInstance;
  timer: NodeJS.Timeout | null;
  consumed: boolean;
  status: HeadlessOAuthStatus;
  enrollment: Promise<void> | null;
  closing: Promise<void> | null;
}

export class HeadlessOAuthSessionService {
  private session: OAuthSession | null = null;
  private readonly completed = new Map<string, HeadlessOAuthStatus>();
  private starting: Promise<{ sessionId: string; authorizationUrl: string }> | null = null;
  private stopping = false;

  constructor(
    private readonly enroll: typeof enrollGoogleAccount = enrollGoogleAccount,
    private readonly reloadGatewayAccounts: () => Promise<boolean> = async () => false,
    private readonly timeoutMs: number = SESSION_TIMEOUT_MS,
  ) {}

  async start(oauthClientKey?: string): Promise<{ sessionId: string; authorizationUrl: string }> {
    if (this.stopping) {
      throw new Error('OAuth login is unavailable during shutdown');
    }
    if (this.starting || this.session?.status.state === 'pending') {
      throw new OAuthLoginActiveError();
    }

    const starting = this.startSession(oauthClientKey);
    this.starting = starting;
    try {
      return await starting;
    } finally {
      this.starting = null;
    }
  }

  private async startSession(
    oauthClientKey?: string,
  ): Promise<{ sessionId: string; authorizationUrl: string }> {
    const clientKey = oauthClientKey ?? GoogleAPIService.getActiveOAuthClientKey();
    const session: OAuthSession = {
      id: crypto.randomUUID(),
      state: crypto.randomBytes(32).toString('base64url'),
      redirectUri: '',
      clientKey,
      server: Fastify({ logger: false, forceCloseConnections: true }),
      timer: null,
      consumed: false,
      status: { state: 'pending' },
      enrollment: null,
      closing: null,
    };
    session.server.addHook('onRequest', async (request, reply) => {
      if (request.method !== 'GET') {
        return reply.header('Allow', 'GET').code(405).send('Method Not Allowed');
      }
    });
    session.server.get('/oauth-callback', (request, reply) =>
      this.handleCallback(session, request, reply),
    );
    await session.server.listen({ port: 0, host: LOOPBACK_HOST });

    const address = session.server.server.address();
    if (!address || typeof address === 'string') {
      await this.closeListener(session);
      throw new Error('OAuth callback listener has no TCP port');
    }
    session.redirectUri = `http://${LOOPBACK_HOST}:${address.port}/oauth-callback`;
    try {
      if (this.stopping) {
        throw new Error('OAuth login is unavailable during shutdown');
      }
      const authorizationUrl = GoogleAPIService.getAuthUrl(clientKey, {
        redirectUri: session.redirectUri,
        state: session.state,
      });
      this.session = session;
      session.timer = setTimeout(() => {
        this.fail(session, 'OAuth login timed out');
      }, this.timeoutMs);
      session.timer.unref();
      return { sessionId: session.id, authorizationUrl };
    } catch (error) {
      await this.closeListener(session);
      throw error;
    }
  }

  status(sessionId: string): HeadlessOAuthStatus | null {
    return this.session?.id === sessionId
      ? this.session.status
      : (this.completed.get(sessionId) ?? null);
  }

  completeCode(sessionId: string, code: string): boolean {
    const session = this.session;
    if (
      this.stopping ||
      !session ||
      session.id !== sessionId ||
      session.consumed ||
      session.status.state !== 'pending'
    ) {
      return false;
    }
    session.consumed = true;
    this.clearTimer(session);
    session.enrollment = this.complete(session, code);
    return true;
  }

  private handleCallback(
    session: OAuthSession,
    request: FastifyRequest,
    response: FastifyReply,
  ): void {
    const url = new URL(request.url, session.redirectUri);
    if (url.searchParams.get('state') !== session.state) {
      void response.code(400).send('Invalid authorization state');
      return;
    }
    if (this.stopping) {
      void response.code(503).send('OAuth login is unavailable');
      return;
    }
    if (session.consumed || session.status.state !== 'pending') {
      void response.code(409).send('Authorization already handled');
      return;
    }
    if (url.searchParams.has('error')) {
      session.consumed = true;
      response.raw.once('finish', () => this.fail(session, 'Google authorization was denied'));
      void response.code(400).send('Authorization denied. Return to the terminal.');
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      void response.code(400).send('Missing authorization code');
      return;
    }

    session.consumed = true;
    this.clearTimer(session);
    const enrollment = Promise.withResolvers<void>();
    session.enrollment = enrollment.promise;
    // Release the browser response before closing the listener and exchanging the code.
    response.raw.once('finish', () => {
      if (this.stopping) {
        this.fail(session, 'OAuth login was cancelled');
        enrollment.resolve();
        return;
      }
      void this.complete(session, code).then(enrollment.resolve);
    });
    response.raw.once('close', () => {
      if (!response.raw.writableFinished) {
        this.fail(session, 'OAuth callback connection closed');
        enrollment.resolve();
      }
    });
    void response.code(200).type('text/html; charset=utf-8').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Login Successful</title></head>
<body style="font-family:sans-serif;text-align:center;padding-top:50px">
<h1>Login Successful</h1>
<p>You can close this window and return to Antigravity Manager.</p>
<script>setTimeout(() => window.close(), 3000);</script>
</body></html>`);
  }

  private async complete(session: OAuthSession, code: string): Promise<void> {
    try {
      await this.closeListener(session);
      const account = await this.enroll(code, {
        oauthClientKey: session.clientKey,
        redirectUri: session.redirectUri,
      });
      try {
        await this.reloadGatewayAccounts();
      } catch {
        logger.warn('Headless OAuth account was saved but gateway cache refresh failed');
      }
      session.status = { state: 'succeeded', account: { id: account.id, email: account.email } };
      this.remember(session);
      this.clearTimer(session);
    } catch (error) {
      logger.error('Headless OAuth account enrollment failed', {
        kind: error instanceof DuplicateGoogleAccountError ? 'duplicate' : 'enrollment',
      });
      this.fail(
        session,
        error instanceof DuplicateGoogleAccountError
          ? 'Google account already exists'
          : 'Google account enrollment failed',
      );
    }
  }

  private fail(session: OAuthSession, message: string): void {
    if (session.status.state !== 'pending') {
      return;
    }
    session.status = { state: 'failed', message };
    this.remember(session);
    this.clearTimer(session);
    void this.closeListener(session).catch((error: unknown) => {
      logger.warn('Failed to close OAuth callback listener', error);
    });
  }

  private clearTimer(session: OAuthSession): void {
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
  }

  private remember(session: OAuthSession): void {
    this.completed.set(session.id, session.status);
    if (this.completed.size > 8) {
      const oldest = this.completed.keys().next().value;
      if (oldest) {
        this.completed.delete(oldest);
      }
    }
  }

  private async closeListener(session: OAuthSession): Promise<void> {
    if (session.closing) {
      return session.closing;
    }
    if (!session.server.server.listening) {
      return;
    }
    session.closing = session.server.close().then(() => undefined);
    await session.closing;
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.session;
    if (!session || session.id !== sessionId || session.enrollment) {
      return;
    }
    this.fail(session, 'OAuth login was cancelled');
    await this.closeListener(session);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.starting) {
      await this.starting.catch(() => undefined);
    }
    const session = this.session;
    if (!session) {
      return;
    }
    if (session.enrollment) {
      await session.enrollment;
    }
    if (session.status.state === 'pending') {
      session.status = { state: 'failed', message: 'OAuth login was cancelled' };
      this.remember(session);
    }
    this.clearTimer(session);
    await this.closeListener(session);
  }
}
