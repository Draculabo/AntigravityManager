import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyMultipart from '@fastify/multipart';
import { AppModule } from './app.module';
import { logger } from '../shared/logging/logger';
import { AccountLeaseService } from '../modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import {
  OpenAIController,
  type ResponsesRequestBody,
} from '../modules/proxy-gateway/server/modules/openai/openai.controller';
import { ProxyService } from '../modules/proxy-gateway/server/proxy.service';
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
    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
      logger: ['error', 'warn', 'log'],
    });

    await app.register(fastifyMultipart, {
      limits: {
        files: 16,
        fileSize: 100 * 1024 * 1024,
        fields: 32,
      },
    });

    // Enable CORS
    app.enableCors();

    await app.listen(port, '0.0.0.0');
    const openAIController = app.get(OpenAIController);
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
        const prepared = openAIController.prepareResponsesRequest(
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
