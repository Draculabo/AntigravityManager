import type { CoreRpcClient } from '@/core/rpc/client';
import type {
  GatewayStatusSchema,
  ContextCacheStatusSchema,
  GatewayStartResultSchema,
  GatewayStopResultSchema,
} from '@/core/rpc/schema';
import type { z } from 'zod';
import { getContextCacheStatus, getGatewayStatus, startGateway, stopGateway } from './handlers';

type GatewayStatus = z.infer<typeof GatewayStatusSchema>;
type ContextCacheStatus = z.infer<typeof ContextCacheStatusSchema>;
type GatewayStartResult = z.infer<typeof GatewayStartResultSchema>;
type GatewayStopResult = z.infer<typeof GatewayStopResultSchema>;

export interface GatewayAdapter {
  status(): Promise<GatewayStatus>;
  contextCacheStats(): Promise<ContextCacheStatus>;
  start(port: number): Promise<GatewayStartResult>;
  stop(): Promise<GatewayStopResult>;
}

type StandaloneCoreGatewayOperations = Pick<
  CoreRpcClient,
  'gatewayStatus' | 'contextCacheStatus' | 'startGateway' | 'stopGateway'
>;

export type GatewaySelection =
  | { mode: 'desktop-embedded' }
  | { mode: 'standalone-core'; client: StandaloneCoreGatewayOperations };

function createDesktopEmbeddedAdapter(): GatewayAdapter {
  return {
    status: getGatewayStatus,
    contextCacheStats: async () => getContextCacheStatus(),
    start: startGateway,
    stop: async () => {
      const success = await stopGateway();
      if (!success) {
        throw new Error('Failed to stop gateway');
      }
      return { success: true };
    },
  };
}

function createStandaloneCoreAdapter(client: StandaloneCoreGatewayOperations): GatewayAdapter {
  return {
    status: () => client.gatewayStatus(),
    contextCacheStats: () => client.contextCacheStatus(),
    start: (port) => client.startGateway(port),
    stop: () => client.stopGateway(),
  };
}

let selectedAdapter: GatewayAdapter = createDesktopEmbeddedAdapter();

/** Select once during main-process startup, before renderer RPC calls are accepted. */
export function selectGatewayAdapter(selection: GatewaySelection): void {
  selectedAdapter =
    selection.mode === 'desktop-embedded'
      ? createDesktopEmbeddedAdapter()
      : createStandaloneCoreAdapter(selection.client);
}

export function getGatewayAdapter(): GatewayAdapter {
  return selectedAdapter;
}
