import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyMultipart from '@fastify/multipart';
import { AppModule } from './app.module';
import { logger } from '../shared/logging/logger';
import { AccountLeaseService } from '../modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import {
  OpenAIOperations,
  type ResponsesRequestBody,
} from '../modules/proxy-gateway/server/modules/openai/openai-operations.service';
import { ProxyService } from '../modules/proxy-gateway/server/proxy.service';
import { DEFAULT_MAX_FILE_BYTES } from '../modules/proxy-gateway/server/modules/files/file-store.types';
import { attachOpenAIResponsesWebSocketServer } from '../modules/proxy-gateway/server/modules/openai/responses/openai-responses-websocket.server';
import {
  extractApiKeyToken,
  hasConfiguredApiKey,
  type RequestHeaders,
} from '../modules/proxy-gateway/server/guards/api-key-auth.util';
import { isObservable } from 'rxjs';

import { ProxyConfig } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from './server-config';

let app: NestFastifyApplication | null = null;
let currentPort: number = 0;
let detachResponsesWebSocketServer: (() => void) | null = null;

export type NestServerStartResult =
  | {
      success: true;
      port: number;
      base_url: string;
    }
  | {
      success: false;
      reason: 'address-in-use' | 'unknown';
      port: number;
      message: string;
    };

interface RawMediaBodyParserHost {
  addContentTypeParser: (
    matcher: RegExp,
    options: { bodyLimit: number; parseAs: 'buffer' },
    handler: (request: unknown, body: Buffer, done: (error: null, body: Buffer) => void) => void,
  ) => void;
}

/**
 * Lets `POST /upload/v1beta/files` accept Google's simple media form, where the
 * whole request body is the file and `Content-Type` names its type.
 *
 * Registered for media families only, and with its own body limit rather than
 * the server's: `application/json` and `multipart/form-data` already have
 * exact-match parsers, Fastify prefers an exact match over a matcher, so every
 * existing route keeps both its parser and its current ceiling.
 */
function registerRawMediaBodyParser(instance: RawMediaBodyParserHost): void {
  instance.addContentTypeParser(
    /^(?:application|audio|font|image|model|text|video)\//u,
    { bodyLimit: DEFAULT_MAX_FILE_BYTES + 1024 * 1024, parseAs: 'buffer' },
    (_request, body, done) => {
      done(null, body);
    },
  );
}

function isAddressInUseError(error: unknown): boolean {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) {
    return false;
  }

  return Reflect.get(error, 'code') === 'EADDRINUSE';
}

async function cleanupFailedServerStart() {
  if (!app) {
    return;
  }

  try {
    detachResponsesWebSocketServer?.();
    detachResponsesWebSocketServer = null;
    await app.close();
  } catch (closeError) {
    logger.warn('Failed to clean up NestJS server after startup failure', closeError);
  } finally {
    app = null;
    currentPort = 0;
  }
}

export async function bootstrapNestServer(config: ProxyConfig): Promise<NestServerStartResult> {
  const port = config.port || 8045;
  if (app) {
    logger.info('NestJS server already running.');
    return {
      success: true,
      port: currentPort,
      base_url: `http://localhost:${currentPort}`,
    };
  }

  setServerConfig(config);

  try {
    const fastifyAdapter = new FastifyAdapter();
    app = await NestFactory.create<NestFastifyApplication>(AppModule, fastifyAdapter, {
      logger: ['error', 'warn', 'log'],
    });

    await app.register(fastifyMultipart, {
      limits: {
        files: 16,
        fileSize: 100 * 1024 * 1024,
        fields: 32,
      },
    });
    registerRawMediaBodyParser(fastifyAdapter.getInstance() as RawMediaBodyParserHost);

    const apiKeyConfigured = hasConfiguredApiKey(config.api_key);
    if (apiKeyConfigured) {
      app.enableCors();
    }

    const listenHost = apiKeyConfigured ? '0.0.0.0' : '127.0.0.1';
    await app.listen(port, listenHost);
    const openAIOperations = app.get(OpenAIOperations);
    const proxyService = app.get(ProxyService);
    detachResponsesWebSocketServer = attachOpenAIResponsesWebSocketServer(app.getHttpServer(), {
      isAuthorized: (request) => {
        const configuredApiKey = getConfiguredApiKey();
        return (
          !hasConfiguredApiKey(configuredApiKey) ||
          extractApiKeyToken(request.headers as RequestHeaders) === configuredApiKey
        );
      },
      streamRequest: async (request) => {
        const prepared = openAIOperations.prepareResponsesRequest(
          request as unknown as ResponsesRequestBody,
        );
        if (!prepared) {
          throw new Error(
            `Unknown or expired previous_response_id: ${String(request.previous_response_id ?? '')}`,
          );
        }

        const result = await proxyService.handleChatCompletions(prepared.request, 'responses');
        if (!isObservable(result)) {
          throw new Error('Responses WebSocket request did not produce a stream');
        }
        return result;
      },
    });
    currentPort = port;
    logger.info(`NestJS Proxy Server running on http://localhost:${port}`);
    return {
      success: true,
      port,
      base_url: `http://localhost:${port}`,
    };
  } catch (error) {
    await cleanupFailedServerStart();

    if (isAddressInUseError(error)) {
      const message = `Port ${port} is already in use`;
      logger.warn(`NestJS Proxy Server could not start: ${message}`, error);
      return {
        success: false,
        reason: 'address-in-use',
        port,
        message,
      };
    }

    logger.error('Failed to start NestJS server', error);
    return {
      success: false,
      reason: 'unknown',
      port,
      message: error instanceof Error ? error.message : 'Failed to start NestJS server',
    };
  }
}

export async function stopNestServer(): Promise<boolean> {
  if (app) {
    try {
      detachResponsesWebSocketServer?.();
      detachResponsesWebSocketServer = null;
      await app.close();
      app = null;
      currentPort = 0;
      logger.info('NestJS server stopped.');
      return true;
    } catch (e) {
      logger.error('Failed to stop NestJS server', e);
      return false;
    }
  }
  return true;
}

export function isNestServerRunning(): boolean {
  return app !== null;
}

export async function reloadNestServerAccountLeaseCache(): Promise<boolean> {
  if (!app) {
    return false;
  }

  const accountLeaseService = app.get(AccountLeaseService);
  await accountLeaseService.reloadAllAccountsOrThrow();
  return true;
}

function getConfiguredApiKey(): string | undefined {
  return getServerConfig()?.api_key;
}

export async function getNestServerStatus(): Promise<{
  running: boolean;
  port: number;
  base_url: string;
  active_accounts: number;
}> {
  const running = isNestServerRunning();
  let activeAccounts = 0;

  if (app) {
    try {
      const accountLeaseService = app.get(AccountLeaseService);
      activeAccounts = accountLeaseService.getAccountCount();
    } catch {
      // AccountLeaseService might not be available
    }
  }

  return {
    running,
    port: currentPort,
    base_url: running ? `http://localhost:${currentPort}` : '',
    active_accounts: activeAccounts,
  };
}
