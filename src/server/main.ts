import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { logger } from '../utils/logger';
import { TokenManagerService } from './modules/proxy/token-manager.service';

import { ProxyConfig } from '../types/config';
import { setServerConfig } from './server-config';

let app: NestFastifyApplication | null = null;
let currentPort: number = 0;

export async function bootstrapNestServer(config: ProxyConfig): Promise<boolean> {
  const port = config.port || 8045;
  if (app) {
    logger.info('NestJS server already running.');
    return true;
  }

  setServerConfig(config);

  try {
    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
      logger: ['error', 'warn', 'log'],
    });

    // Enable CORS
    app.enableCors();

    await app.listen(port, '0.0.0.0');
    currentPort = port;
    logger.info(`NestJS Proxy Server running on http://localhost:${port}`);
    return true;
  } catch (error) {
    logger.error('Failed to start NestJS server', error);
    return false;
  }
}

export async function stopNestServer(): Promise<boolean> {
  if (app) {
    try {
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
      const tokenManager = app.get(TokenManagerService);
      activeAccounts = tokenManager.getAccountCount();
    } catch (e) {
      // TokenManager might not be available
    }
  }

  return {
    running,
    port: currentPort,
    base_url: running ? `http://localhost:${currentPort}` : '',
    active_accounts: activeAccounts,
  };
}
