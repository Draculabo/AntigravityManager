/**
 * Gateway IPC Handlers
 * Provides ORPC handlers for controlling the API Gateway service (NestJS version)
 */
import { getNestServerStatus, type NestServerStartResult } from '@/server/main';
import { explicitContextCacheManager } from '../server/modules/gemini/explicit-context-cache.store';
import { gatewayLifecycleService } from '../services/gateway-lifecycle.service';

/**
 * Start the gateway server (NestJS)
 */
export const startGateway = (port: number): Promise<NestServerStartResult> =>
  gatewayLifecycleService.start(port);

/**
 * Stop the gateway server (NestJS)
 */
export const stopGateway = (): Promise<boolean> => gatewayLifecycleService.stop();

/**
 * Get gateway status (NestJS)
 */
export const getGatewayStatus = async () => {
  return getNestServerStatus();
};

/**
 * Returns diagnostic counters only; cache resource names and prompt contents
 * intentionally remain inside the gateway process.
 */
export const getContextCacheStatus = () => {
  return {
    enabled: process.env.PROXY_CONTEXT_CACHE_ENABLED?.trim().toLowerCase() !== 'false',
    stats: explicitContextCacheManager.getStats(),
  };
};
