import {
  getContextWindow,
  getMaxOutputTokens,
} from '../../../../modules/proxy-gateway/antigravity/ModelSpecs';
import { getServerConfig } from '@/server/server-config';
import type { AccountLeaseService } from '../../modules/account-lease/account-lease.service';
import { ModelRoutingService } from './model-routing.service';
import { RetiredModelError } from '../../common/exceptions/retired-model.exception';
import { NoAvailableAdaptiveModelError } from './adaptive-model-routing';

type ModelDiscoverySource = Partial<
  Pick<AccountLeaseService, 'getModelDiscoveryCapabilities' | 'getAvailableAdaptiveModels'>
>;

function readPhysicalModelMetadata(
  model: string,
  source: ModelDiscoverySource | undefined,
  allowBuiltInFallback: boolean,
) {
  const { missingRegisteredRoute, ...capabilities } =
    source?.getModelDiscoveryCapabilities?.(model, allowBuiltInFallback) ?? {};
  return {
    missingRegisteredRoute,
    metadata: {
      context: getContextWindow(model),
      output: Math.min(getMaxOutputTokens(model), capabilities.max_output_tokens ?? Infinity),
      capabilities,
    },
  };
}

export type ModelDiscoveryMetadata = ReturnType<typeof readPhysicalModelMetadata>['metadata'];

/** Unavailable opt-in policies disappear from discovery; unrelated errors remain visible. */
export function tryResolveModelDiscoveryMetadata(
  model: string,
  source?: ModelDiscoverySource,
  config = getServerConfig(),
  preservePhysicalModel = false,
): ModelDiscoveryMetadata | undefined {
  try {
    const route = new ModelRoutingService().resolveModelRoute(model, config, {
      getAvailableModels: () => source?.getAvailableAdaptiveModels?.() ?? new Set(),
    });
    const physicalTarget = route.source === 'configured' || route.source === 'dynamic-legacy';
    const { metadata, missingRegisteredRoute } = readPhysicalModelMetadata(
      route.resolvedModel,
      source,
      physicalTarget,
    );
    if (!config?.only_raw_quota_models && missingRegisteredRoute) {
      return undefined;
    }
    return metadata;
  } catch (error) {
    if (error instanceof RetiredModelError) {
      return undefined;
    }
    if (error instanceof NoAvailableAdaptiveModelError) {
      // A hidden alias must not erase a physical ID advertised independently by the pool.
      return preservePhysicalModel
        ? readPhysicalModelMetadata(model, source, false).metadata
        : undefined;
    }
    throw error;
  }
}
