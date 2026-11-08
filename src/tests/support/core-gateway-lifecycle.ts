import { vi } from 'vitest';
import type { createCoreRpcOperations } from '@/core/rpc/router';

type CoreGatewayLifecycle = Parameters<typeof createCoreRpcOperations>[0];

export function mockCoreGatewayLifecycle(): CoreGatewayLifecycle {
  return {
    startGateway: vi.fn(),
    stopGateway: vi.fn(),
    manualStartGateway: vi.fn(),
    manualStopGateway: vi.fn(),
    retryGatewaySaveChoice: vi.fn(),
  };
}
