import 'reflect-metadata';

import { loadDotEnv } from './env';

const dotenv = loadDotEnv();

import { CloudAccountRepo } from '../ipc/database/cloudHandler';
import { ConfigManager } from '../ipc/config/manager';
import { bootstrapNestServer, stopNestServer } from '../server/main';
import { CloudMonitorService } from '../services/CloudMonitorService';
import { logger } from '../utils/logger';
import { startManagementServer, stopManagementServer } from './managementServer';

const DEFAULT_MANAGEMENT_PORT = Number(process.env.AGM_MANAGEMENT_PORT ?? 8046);

async function main() {
  process.env.AGM_STANDALONE = '1';
  logger.info('[standalone] Antigravity Manager server starting');
  if (dotenv.path) {
    logger.info(`[standalone] Loaded ${dotenv.loaded} env vars from ${dotenv.path}`);
  }

  const adminPassword = process.env.AGM_ADMIN_PASSWORD?.trim();
  if (!adminPassword) {
    throw new Error(
      'AGM_ADMIN_PASSWORD is required. Set it in your .env (see .env.example) before starting the server.',
    );
  }

  await CloudAccountRepo.init();
  logger.info('[standalone] Cloud account repository ready');

  const config = ConfigManager.loadConfig();
  const envApiKey = process.env.AGM_API_KEY?.trim();
  if (envApiKey && config.proxy) {
    config.proxy.api_key = envApiKey;
    logger.info('[standalone] Proxy API key loaded from AGM_API_KEY');
  } else if (config.proxy) {
    logger.warn(
      '[standalone] AGM_API_KEY not set — proxy is in open mode. Set it in .env to require Bearer auth.',
    );
  }

  if (config.proxy) {
    const ok = await bootstrapNestServer(config.proxy);
    if (!ok) {
      throw new Error('NestJS proxy server failed to start');
    }
    logger.info(`[standalone] OpenAI/Anthropic proxy listening on port ${config.proxy.port ?? 8045}`);
  } else {
    logger.warn('[standalone] No proxy config present; proxy will not be started');
  }

  await startManagementServer(DEFAULT_MANAGEMENT_PORT);
  logger.info(`[standalone] Management API listening on port ${DEFAULT_MANAGEMENT_PORT}`);

  if (CloudAccountRepo.getSetting('auto_switch_enabled', false)) {
    CloudMonitorService.start();
    logger.info('[standalone] Auto-switch monitor started');
  } else {
    CloudMonitorService.poll().catch((err) =>
      logger.warn('[standalone] Initial monitor poll failed', err),
    );
  }
}

async function shutdown(signal: string) {
  logger.info(`[standalone] Received ${signal}, shutting down`);
  try {
    CloudMonitorService.stop();
  } catch (err) {
    logger.warn('[standalone] CloudMonitor stop failed', err);
  }
  await Promise.allSettled([stopNestServer(), stopManagementServer()]);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => logger.error('[standalone] uncaughtException', err));
process.on('unhandledRejection', (reason) => logger.error('[standalone] unhandledRejection', reason));

main().catch((err) => {
  logger.error('[standalone] Fatal startup error', err);
  process.exit(1);
});
