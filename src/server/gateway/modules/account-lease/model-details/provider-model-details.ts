import { isNumber } from 'lodash-es';
import type { CloudQuotaModelInfo } from '@/modules/cloud-account/types';
import type { ModelThinkingTransport } from '../../../common/model-thinking-transport';

/**
 * Provider-declared input modalities, limited to what the quota payload actually carries. `undefined` means the discovery source
 * was silent; `false` is an explicit provider statement that the modality is
 * unavailable. A later source such as `listModelConfigs` can produce this
 * same shape without changing capability consumers.
 */
export interface ProviderModelModalities {
  supportsImages?: boolean;
  supportedMimeTypes?: Readonly<Record<string, boolean>>;
}

/**
 * Capability facts normalized from one provider model descriptor. These values
 * intentionally have no defaults: static model specs are fallback data only
 * when the provider omitted the corresponding ModelDetails scalar.
 */
export interface ProviderModelDetails {
  maxOutputTokens?: number;
  thinkingBudget?: number;
  supportsThinking?: boolean;
  thinkingTransport?: ModelThinkingTransport;
  modalities?: ProviderModelModalities;
}

function toPositiveInteger(value: number | undefined): number | undefined {
  if (!isNumber(value) || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return Math.floor(value);
}

function toNonNegativeInteger(value: number | undefined): number | undefined {
  if (!isNumber(value) || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return Math.floor(value);
}

/**
 * Converts persisted fetchAvailableModels ModelDetails into the source-neutral
 * shape used by account-lease consumers. Keep this adapter narrow so a richer
 * discovery verb can later provide the same facts without a consumer rewrite.
 */
export function toProviderModelDetails(
  modelDetails: CloudQuotaModelInfo | undefined,
): ProviderModelDetails | undefined {
  if (!modelDetails) {
    return undefined;
  }

  const modalities: ProviderModelModalities = {
    supportsImages: modelDetails.supports_images,
    supportedMimeTypes: modelDetails.supported_mime_types,
  };
  const hasModalities = Object.values(modalities).some((value) => value !== undefined);
  const maxOutputTokens =
    toPositiveInteger(modelDetails.max_output_tokens) ?? toPositiveInteger(modelDetails.max_tokens);
  const thinkingBudget = toNonNegativeInteger(modelDetails.thinking_budget);
  let thinkingTransport: ModelThinkingTransport | undefined;
  if (modelDetails.supports_thinking === false) {
    thinkingTransport = { kind: 'disabled' };
  } else if (modelDetails.thinking_level !== undefined) {
    thinkingTransport = { kind: 'level', defaultLevel: modelDetails.thinking_level };
  } else if (modelDetails.thinking_budget === -1) {
    thinkingTransport = { kind: 'budget', defaultBudget: -1 };
  } else if (thinkingBudget !== undefined) {
    thinkingTransport = { kind: 'budget', defaultBudget: thinkingBudget };
  }

  if (
    !hasModalities &&
    maxOutputTokens === undefined &&
    thinkingBudget === undefined &&
    thinkingTransport === undefined &&
    modelDetails.supports_thinking === undefined
  ) {
    return undefined;
  }

  return {
    maxOutputTokens,
    thinkingBudget,
    ...(thinkingTransport ? { thinkingTransport } : {}),
    ...(modelDetails.supports_thinking !== undefined
      ? { supportsThinking: modelDetails.supports_thinking }
      : {}),
    modalities: hasModalities ? modalities : undefined,
  };
}
