import { getContextWindow, getMaxOutputTokens } from '../../../../modules/proxy-gateway/antigravity/ModelSpecs';
import { getServerConfig } from '@/server/server-config';
import type { AccountLeaseService } from '../../modules/account-lease/account-lease.service';
import { ModelRoutingService } from './model-routing.service';
import { RetiredModelError } from '../../common/exceptions/retired-model.exception';
import { NoAvailableAdaptiveModelError } from './adaptive-model-routing';

type ModelDiscoverySource = Partial<
  Pick<AccountLeaseService, 'getModelDiscoveryCapabilities' | 'getAvailableAdaptiveModels'>
>;

/** Discovery resolves once through generation policy without recording a route miss. */
export function resolveModelDiscoveryMetadata(
  model: string,
  source?: ModelDiscoverySource,
  config = getServerConfig(),
) {
  const route = new ModelRoutingService().resolveModelRoute(model, config, {
    getAvailableModels: () => source?.getAvailableAdaptiveModels?.() ?? new Set(),
  });
  return readPhysicalModelMetadata(
    route.resolvedModel,
    source,
    route.source === 'configured' || route.source === 'dynamic-legacy',
  );
}

function readPhysicalModelMetadata(
  model: string,
  source: ModelDiscoverySource | undefined,
  allowBuiltInFallback: boolean,
) {
  const capabilities = source?.getModelDiscoveryCapabilities?.(model, allowBuiltInFallback) ?? {};
  return {
    context: getContextWindow(model),
    output: Math.min(getMaxOutputTokens(model), capabilities.max_output_tokens ?? Infinity),
    capabilities,
  };
}

/** Unavailable opt-in policies disappear from discovery; unrelated errors remain visible. */
export function tryResolveModelDiscoveryMetadata(
  model: string,
  source?: ModelDiscoverySource,
  config = getServerConfig(),
  preservePhysicalModel = false,
) {
  try {
    return resolveModelDiscoveryMetadata(model, source, config);
  } catch (error) {
    if (error instanceof RetiredModelError) {
      return undefined;
    }
    if (error instanceof NoAvailableAdaptiveModelError) {
      // A hidden alias must not erase a physical ID advertised independently by the pool.
      return preservePhysicalModel ? readPhysicalModelMetadata(model, source, false) : undefined;
    }
    throw error;
  }
}
