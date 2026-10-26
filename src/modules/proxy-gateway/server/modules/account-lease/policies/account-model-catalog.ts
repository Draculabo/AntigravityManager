import { isNumber } from 'lodash-es';
import { getPublicModelIdForDisplayName } from '../../../../antigravity/ModelMapping';
import {
  type AccountLeaseTokenData,
  normalizeModelId,
} from '../interfaces/account-lease-token-types';
import {
  type ProviderModelDetails,
  toProviderModelDetails,
} from '../model-details/provider-model-details';

export type AccountModelEvidenceSource = 'provider-catalog' | 'quota-snapshot';

export interface AccountModelEvidence {
  modelId: string;
  source: AccountModelEvidenceSource;
  displayName?: string;
  details?: ProviderModelDetails;
}

/** Reads advertised model metadata; request failure state remains with the lease policy. */
export class AccountModelCatalog {
  constructor(private readonly options: { getTokenCache(): Map<string, AccountLeaseTokenData> }) {}

  /**
   * Return positive physical-model evidence without projecting provider IDs
   * into public aliases. Provider model descriptors are stronger evidence than
   * the derived legacy quota map, but both remain visible when they contain
   * different physical IDs.
   */
  getPositiveModelEvidenceFromToken(tokenData: AccountLeaseTokenData): AccountModelEvidence[] {
    const evidence = new Map<string, AccountModelEvidence>();

    for (const [modelId, modelInfo] of Object.entries(tokenData.quota?.models ?? {})) {
      const normalizedModelId = normalizeModelId(modelId)?.toLowerCase();
      if (!normalizedModelId) {
        continue;
      }

      const details = toProviderModelDetails(modelInfo);
      evidence.set(normalizedModelId, {
        modelId: normalizedModelId,
        source: 'provider-catalog',
        ...(modelInfo.display_name ? { displayName: modelInfo.display_name } : {}),
        ...(details ? { details } : {}),
      });
    }

    for (const modelId of Object.keys(tokenData.model_quotas ?? {})) {
      const normalizedModelId = normalizeModelId(modelId)?.toLowerCase();
      if (!normalizedModelId || evidence.has(normalizedModelId)) {
        continue;
      }

      evidence.set(normalizedModelId, {
        modelId: normalizedModelId,
        source: 'quota-snapshot',
      });
    }

    return [...evidence.values()].sort((left, right) => left.modelId.localeCompare(right.modelId));
  }

  getAllCollectedModels(): Set<string> {
    const allModels = new Set<string>();
    for (const tokenData of this.options.getTokenCache().values()) {
      for (const evidence of this.getPositiveModelEvidenceFromToken(tokenData)) {
        allModels.add(
          evidence.source === 'provider-catalog'
            ? (getPublicModelIdForDisplayName(evidence.displayName) ?? evidence.modelId)
            : evidence.modelId,
        );
      }
    }
    return allModels;
  }

  /**
   * Return quota keys without projecting provider display names to public aliases.
   * Raw model discovery must expose physical upstream IDs from every loaded account.
   */
  getAllRawQuotaModels(): Set<string> {
    const allModels = new Set<string>();
    for (const tokenData of this.options.getTokenCache().values()) {
      for (const evidence of this.getPositiveModelEvidenceFromToken(tokenData)) {
        allModels.add(evidence.modelId);
      }
    }
    return allModels;
  }

  getAvailableModelsFromToken(tokenData: AccountLeaseTokenData): Set<string> {
    const availableModels = new Set<string>();

    for (const modelId of Object.keys(tokenData.model_quotas ?? {})) {
      const normalized = normalizeModelId(modelId)?.toLowerCase();
      if (normalized) {
        availableModels.add(normalized);
      }
    }

    for (const modelId of Object.keys(tokenData.quota?.models ?? {})) {
      const normalized = normalizeModelId(modelId)?.toLowerCase();
      if (normalized) {
        availableModels.add(normalized);
      }
    }

    return availableModels;
  }

  getModelOutputLimitForAccount(accountId: string, modelName: string): number | undefined {
    const tokenData = this.options.getTokenCache().get(accountId);
    const normalizedModel = normalizeModelId(modelName);
    if (!tokenData || !normalizedModel) {
      return undefined;
    }

    const providerCap = this.getProviderModelDetails(tokenData, normalizedModel)?.maxOutputTokens;
    if (providerCap !== undefined) {
      return providerCap;
    }

    return tokenData.model_limits[normalizedModel];
  }

  private getProviderModelDetails(
    tokenData: AccountLeaseTokenData,
    normalizedModel: string,
  ): ProviderModelDetails | undefined {
    for (const [quotaModelName, modelInfo] of Object.entries(tokenData.quota?.models ?? {})) {
      if (normalizeModelId(quotaModelName) === normalizedModel) {
        return toProviderModelDetails(modelInfo);
      }
    }
    return undefined;
  }

  getModelThinkingBudgetForAccount(accountId: string, modelName: string): number | undefined {
    const tokenData = this.options.getTokenCache().get(accountId);
    const normalizedModel = normalizeModelId(modelName);
    if (!tokenData || !normalizedModel) {
      return undefined;
    }

    for (const [quotaModelName, modelInfo] of Object.entries(tokenData.quota?.models ?? {})) {
      if (normalizeModelId(quotaModelName) !== normalizedModel) {
        continue;
      }
      const budget = modelInfo?.thinking_budget;
      if (isNumber(budget) && Number.isFinite(budget) && budget >= 0) {
        return Math.floor(budget);
      }
    }
    return undefined;
  }
}
