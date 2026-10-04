import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  CORE_OWNER_COMPATIBILITY,
  CORE_OWNER_EPOCH_HEADER,
  CoreHandshakeSchema,
  getProfileFingerprint,
} from './handshake';
import Fastify, { type FastifyInstance } from 'fastify';
import type { CoreStatus } from '@/core/core-service';
import { bindLocalEndpoint } from '@/core/local-endpoint';
import { registerCoreRpcRoutes } from '@/core/rpc/server';
import { CORE_ACCOUNT_MUTATION_TIMEOUT_MS } from '@/core/rpc/timeouts';
import type { CoreRpcOperations } from '@/core/rpc/router';
import { MANAGEMENT_PROTOCOL_VERSION, type ManagementResponse } from './protocol';
import {
  OAuthStartRequestSchema,
  OAuthCompleteRequestSchema,
  OAuthSessionIdSchema,
  type OAuthCancelResponse,
  type OAuthErrorResponse,
  type OAuthStartResponse,
  type OAuthStatusResponse,
  type OAuthCompleteResponse,
} from './protocol';
import {
  OAuthLoginActiveError,
  type HeadlessOAuthSessionService,
} from '@/modules/cloud-account/services/headless-oauth-session.service';

export interface ManagementServerOptions {
  endpoint: string;
  platform?: NodeJS.Platform;
  getStatus(): CoreStatus;
  shutdown(): Promise<void>;
  onShutdownError(error: unknown): void;
  oauth?: Pick<HeadlessOAuthSessionService, 'start' | 'status' | 'cancel' | 'completeCode'>;
  rpc?: CoreRpcOperations;
}

export class ManagementServer {
  private server: FastifyInstance | null = null;
  private shuttingDown = false;
  private readonly ownerEpoch = randomUUID();

  constructor(private readonly options: ManagementServerOptions) {}

  private async listen(): Promise<void> {
    const server = Fastify({
      bodyLimit: 4096,
      connectionTimeout: CORE_ACCOUNT_MUTATION_TIMEOUT_MS,
    });
    server.addHook('onRequest', async (request, reply) => {
      const expected = request.headers[CORE_OWNER_EPOCH_HEADER];
      if (expected !== undefined && expected !== this.ownerEpoch) {
        return reply.code(409).send({ code: 'OWNER_CHANGED', message: 'Core owner changed' });
      }
    });
    server.get('/v1/handshake', async () =>
      CoreHandshakeSchema.parse({
        version: 1,
        compatibility: CORE_OWNER_COMPATIBILITY,
        kind: 'core',
        pid: this.options.getStatus().pid,
        epoch: this.ownerEpoch,
        profile: getProfileFingerprint(),
        ready: !this.shuttingDown && this.options.getStatus().state === 'running',
      }),
    );
    if (this.options.rpc) {
      registerCoreRpcRoutes(
        server,
        this.options.getStatus,
        () => this.shuttingDown,
        this.options.rpc,
      );
    }
    server.get(
      '/v1/status',
      async (): Promise<ManagementResponse> => ({
        version: MANAGEMENT_PROTOCOL_VERSION,
        ok: true,
        status: this.options.getStatus(),
      }),
    );
    server.post('/v1/shutdown', async (_request, reply): Promise<void> => {
      reply.raw.once('finish', () => {
        void this.options.shutdown().catch(this.options.onShutdownError);
      });
      const response: ManagementResponse = {
        version: MANAGEMENT_PROTOCOL_VERSION,
        ok: true,
        shuttingDown: true,
      };
      await reply.send(response);
    });

    if (this.options.oauth) {
      const oauth = this.options.oauth;
      server.post('/v1/oauth/start', async (request, reply) => {
        if (this.shuttingDown || this.options.getStatus().state !== 'running') {
          const response: OAuthErrorResponse = {
            version: MANAGEMENT_PROTOCOL_VERSION,
            ok: false,
            code: 'NOT_READY',
            message: 'Core service is not ready for login',
          };
          return reply.code(503).send(response);
        }
        const input = OAuthStartRequestSchema.safeParse(request.body);
        if (!input.success) {
          const response: OAuthErrorResponse = {
            version: MANAGEMENT_PROTOCOL_VERSION,
            ok: false,
            code: 'INVALID_REQUEST',
            message: 'Invalid OAuth login request',
          };
          return reply.code(400).send(response);
        }
        try {
          const started = await oauth.start(input.data.oauthClientKey);
          const response: OAuthStartResponse = {
            version: MANAGEMENT_PROTOCOL_VERSION,
            ok: true,
            ...started,
          };
          return reply.send(response);
        } catch (error) {
          const response: OAuthErrorResponse = {
            version: MANAGEMENT_PROTOCOL_VERSION,
            ok: false,
            code: error instanceof OAuthLoginActiveError ? 'LOGIN_ACTIVE' : 'LOGIN_UNAVAILABLE',
            message:
              error instanceof OAuthLoginActiveError
                ? 'OAuth login is already active'
                : 'OAuth login could not be started',
          };
          return reply.code(error instanceof OAuthLoginActiveError ? 409 : 503).send(response);
        }
      });

      server.get<{ Params: { sessionId: string } }>(
        '/v1/oauth/status/:sessionId',
        async (request, reply) => {
          if (this.shuttingDown || this.options.getStatus().state !== 'running') {
            const response: OAuthErrorResponse = {
              version: MANAGEMENT_PROTOCOL_VERSION,
              ok: false,
              code: 'NOT_READY',
              message: 'Core service is not ready for login',
            };
            return reply.code(503).send(response);
          }
          const status = oauth.status(request.params.sessionId);
          if (!status) {
            const response: OAuthErrorResponse = {
              version: MANAGEMENT_PROTOCOL_VERSION,
              ok: false,
              code: 'UNKNOWN_SESSION',
              message: 'OAuth login session was not found',
            };
            return reply.code(404).send(response);
          }
          const response: OAuthStatusResponse = {
            version: MANAGEMENT_PROTOCOL_VERSION,
            ok: true,
            status,
          };
          return reply.send(response);
        },
      );

      server.post<{ Params: { sessionId: string } }>(
        '/v1/oauth/complete/:sessionId',
        async (request, reply) => {
          if (this.shuttingDown || this.options.getStatus().state !== 'running') {
            const response: OAuthErrorResponse = {
              version: MANAGEMENT_PROTOCOL_VERSION,
              ok: false,
              code: 'NOT_READY',
              message: 'Core service is not ready for login',
            };
            return reply.code(503).send(response);
          }
          const input = OAuthCompleteRequestSchema.safeParse(request.body);
          if (!OAuthSessionIdSchema.safeParse(request.params.sessionId).success || !input.success) {
            const response: OAuthErrorResponse = {
              version: MANAGEMENT_PROTOCOL_VERSION,
              ok: false,
              code: 'INVALID_REQUEST',
              message: 'Invalid OAuth completion request',
            };
            return reply.code(400).send(response);
          }
          if (!oauth.completeCode(request.params.sessionId, input.data.code)) {
            const response: OAuthErrorResponse = {
              version: MANAGEMENT_PROTOCOL_VERSION,
              ok: false,
              code: 'UNKNOWN_SESSION',
              message: 'OAuth login session is no longer pending',
            };
            return reply.code(409).send(response);
          }
          const response: OAuthCompleteResponse = {
            version: MANAGEMENT_PROTOCOL_VERSION,
            ok: true,
            accepted: true,
          };
          return reply.send(response);
        },
      );

      server.post<{ Params: { sessionId: string } }>(
        '/v1/oauth/cancel/:sessionId',
        async (request, reply) => {
          if (!OAuthSessionIdSchema.safeParse(request.params.sessionId).success) {
            const response: OAuthErrorResponse = {
              version: MANAGEMENT_PROTOCOL_VERSION,
              ok: false,
              code: 'INVALID_REQUEST',
              message: 'Invalid OAuth session',
            };
            return reply.code(400).send(response);
          }
          await oauth.cancel(request.params.sessionId);
          const response: OAuthCancelResponse = {
            version: MANAGEMENT_PROTOCOL_VERSION,
            ok: true,
            cancelled: true,
          };
          return reply.send(response);
        },
      );
    }

    try {
      await server.listen({
        path: this.options.endpoint,
        readableAll: false,
        writableAll: false,
      });
      if ((this.options.platform ?? process.platform) !== 'win32') {
        await fs.chmod(this.options.endpoint, 0o600);
      }
      this.server = server;
    } catch (error) {
      await server.close();
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this.server) {
      throw new Error('Management server is already running');
    }

    await bindLocalEndpoint(this.options.endpoint, this.options.platform ?? process.platform, () =>
      this.listen(),
    );
  }

  async close(): Promise<void> {
    this.shuttingDown = true;
    const server = this.server;
    if (!server) {
      return;
    }
    this.server = null;
    await server.close();
  }

  beginShutdown(): void {
    this.shuttingDown = true;
  }
}
