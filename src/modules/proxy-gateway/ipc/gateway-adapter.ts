import type { CoreRpcClient } from '@/core/rpc/client';
import type {
  GatewayStatusSchema,
  ContextCacheStatusSchema,
  GatewayStartResultSchema,
  GatewayStopResultSchema,
} from '@/core/rpc/schema';
import type { z } from 'zod';
import { getContextCacheStatus, getGatewayStatus, startGateway, stopGateway } from './handlers';
import { playgroundService, type PlaygroundOperations } from '../playground/playground.service';
import { gatewayLifecycleService } from '../services/gateway-lifecycle.service';
import type { GatewayManualStartResult, GatewayManualStopResult, GatewayRememberChoice, GatewayChoicePersistence } from '../services/gateway-management.schema';

type GatewayStatus = z.infer<typeof GatewayStatusSchema>;
type ContextCacheStatus = z.infer<typeof ContextCacheStatusSchema>;
type GatewayStartResult = z.infer<typeof GatewayStartResultSchema>;
type GatewayStopResult = z.infer<typeof GatewayStopResultSchema>;

export interface GatewayAdapter {
  playground: PlaygroundOperations;
  status(): Promise<GatewayStatus>;
  contextCacheStats(): Promise<ContextCacheStatus>;
  start(port: number): Promise<GatewayStartResult>;
  stop(): Promise<GatewayStopResult>;
  manualStart(port: number): Promise<GatewayManualStartResult>;
  manualStop(): Promise<GatewayManualStopResult>;
  retrySaveChoice(choice: GatewayRememberChoice): Promise<GatewayChoicePersistence>;
}

type StandaloneCoreGatewayOperations = Pick<
  CoreRpcClient,
  'gatewayStatus' | 'contextCacheStatus' | 'startGateway' | 'stopGateway' | 'playground' |
  'manualStartGateway' | 'manualStopGateway' | 'retryGatewaySaveChoice'
>;

export type GatewaySelection =
  | { mode: 'desktop-embedded' }
  | { mode: 'standalone-core'; client: StandaloneCoreGatewayOperations };

function createDesktopEmbeddedAdapter(): GatewayAdapter {
  return {
    playground: playgroundService,
    status: getGatewayStatus,
    contextCacheStats: async () => getContextCacheStatus(),
    start: startGateway,
    manualStart: (port) => gatewayLifecycleService.manualStart(port),
    manualStop: () => gatewayLifecycleService.manualStop(),
    retrySaveChoice: (choice) => gatewayLifecycleService.retrySaveChoice(choice),
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
    playground: client.playground,
    status: () => client.gatewayStatus(),
    contextCacheStats: () => client.contextCacheStatus(),
    start: (port) => client.startGateway(port),
    stop: () => client.stopGateway(),
    manualStart: (port) => client.manualStartGateway(port),
    manualStop: () => client.manualStopGateway(),
    retrySaveChoice: (choice) => client.retryGatewaySaveChoice(choice),
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
