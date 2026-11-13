import { getPublishedModelMapping } from '@/modules/config/model-aliases';
import {
  getOpenAICompatibleModels,
  MODEL_LIST_CREATED_AT,
  MODEL_LIST_OWNER,
} from '@/modules/proxy-gateway/antigravity/ModelMapping';
import { getServerConfig } from '@/server/server-config';
import type { AccountLeaseService } from '../account-lease/account-lease.service';
import { tryResolveModelDiscoveryMetadata } from '../../shared/services/model-discovery-metadata';

export interface OpenAIModelMetadata {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  context_length: number;
  max_context_length: number;
  max_input_tokens: number;
  max_model_len: number;
  max_tokens: number;
  max_completion_tokens: number;
  max_output_tokens: number;
  supports_images?: boolean;
  supports_thinking?: boolean;
  capability_source?: 'provider-catalog';
}

type ModelCatalogSource = Pick<
  AccountLeaseService,
  'getAllRawQuotaModels' | 'getAllCollectedModels'
> &
  Partial<
    Pick<AccountLeaseService, 'getModelDiscoveryCapabilities' | 'getAvailableAdaptiveModels'>
  >;

/** One request-local catalog keeps list, retrieve and probes on the same model policy. */
export function readOpenAIModelCatalog(source?: ModelCatalogSource): OpenAIModelMetadata[] {
  const config = getServerConfig();
  const mapping = getPublishedModelMapping(config);
  const onlyRaw = config?.only_raw_quota_models ?? false;
  const dynamicIds = onlyRaw ? source?.getAllRawQuotaModels() : source?.getAllCollectedModels();
  const physicalIds = new Set(dynamicIds);

  return getOpenAICompatibleModels(mapping, physicalIds, onlyRaw).flatMap((id) => {
    const metadata = tryResolveModelDiscoveryMetadata(id, source, config, physicalIds.has(id));
    if (!metadata) {
      return [];
    }
    const { context, output, capabilities } = metadata;
    return [
      {
        id,
        object: 'model',
        created: MODEL_LIST_CREATED_AT,
        owned_by: MODEL_LIST_OWNER,
        context_length: context,
        max_context_length: context,
        max_input_tokens: context,
        max_model_len: context,
        // This is model metadata; the generation request's max_tokens remains an output limit.
        max_tokens: context,
        max_completion_tokens: output,
        max_output_tokens: output,
        ...(capabilities.supports_images !== undefined
          ? { supports_images: capabilities.supports_images }
          : {}),
        ...(capabilities.supports_thinking !== undefined
          ? { supports_thinking: capabilities.supports_thinking }
          : {}),
        ...(Object.keys(capabilities).length
          ? { capability_source: 'provider-catalog' as const }
          : {}),
      },
    ];
  });
}

export function modelNotFoundError(model: string) {
  return {
    error: {
      code: 'model_not_found',
      message: `The model '${model}' does not exist or you do not have access to it.`,
      param: 'model',
      type: 'invalid_request_error',
    },
  };
}
