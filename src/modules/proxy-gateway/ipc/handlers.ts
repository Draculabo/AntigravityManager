/**
 * Gateway IPC Handlers
 * Provides ORPC handlers for controlling the API Gateway service (NestJS version)
 */
import { ConfigManager } from '@/modules/config/ipc/manager';
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
  if (process.env.PROXY_CONTEXT_CACHE_ENABLED?.trim().toLowerCase() === 'false') {
    return {
      enabled: false,
      stats: explicitContextCacheManager.getStats(),
    };
  }
  const configured = ConfigManager.loadConfig().proxy.experimental?.context_cache_enabled;
  return {
    enabled: configured !== undefined ? configured : true,
    stats: explicitContextCacheManager.getStats(),
  };
};
