import {
  AccountModelCatalog,
  consistentCapability,
  type AccountModelEvidence,
  type ModelDiscoveryCapabilities,
} from './account-model-catalog';
import { getPublicModelIdForDisplayName } from '../../../../../modules/proxy-gateway/antigravity/ModelMapping';
import { isRetiredModel } from '../../../../../modules/proxy-gateway/antigravity/retired-models';
import type { ModelThinkingTransport } from '../../../common/model-thinking-transport';
import {
  isModelTierBindingAllowed,
  rebindModelVariant,
  resolveModelVariant,
} from '../../../../../modules/proxy-gateway/antigravity/model-variant-registry';
import {
  type AccountLeaseTokenData,
  normalizeModelId,
} from '../interfaces/account-lease-token-types';
import {
  assertSupportedBareModelEffort,
  isBareModelFamilyAvailable,
  parseBareModelEffort,
  resolveBareFamilyModel,
  type TieredModelSuffix,
} from './account-bare-model-tier';

interface AccountLeaseModelLogger {
  log(message: string): void;
}

interface AccountLeaseModelPolicyOptions {
  getTokenCache: () => Map<string, AccountLeaseTokenData>;
  logger: AccountLeaseModelLogger;
  isModelBlocked(accountId: string, model: string): boolean;
}

const GEMINI_PRO_FALLBACKS = [
  'gemini-3.1-pro-preview',
  'gemini-3-pro-preview',
  'gemini-3-pro-high',
  'gemini-3.1-pro-low',
  'gemini-3-pro-low',
];
const GEMINI_PRO_FAMILY = new Set(['gemini-3-pro', 'gemini-3.1-pro', ...GEMINI_PRO_FALLBACKS]);

const GEMINI_PRO_IMAGE_FAMILY = new Set(['gemini-3-pro-image', 'gemini-3.1-pro-image']);
const GEMINI_FLASH_IMAGE_FAMILY = new Set(['gemini-3-flash-image', 'gemini-3.1-flash-image']);
const GEMINI_4_ARGON_FAMILY = new Set([
  'gemini-4-argon',
  'gemini-4-argon-high',
  'gemini-4-argon-medium',
  'gemini-4-argon-low',
]);

export type AccountModelAvailability = 'unknown' | 'available' | 'unavailable';

export class AccountLeaseModelPolicy {
  private readonly catalog: AccountModelCatalog;

  constructor(private readonly options: AccountLeaseModelPolicyOptions) {
    this.catalog = new AccountModelCatalog(options);
  }

  getAllCollectedModels(): Set<string> {
    return this.catalog.getAllCollectedModels();
  }

  getAllRawQuotaModels(): Set<string> {
    return this.catalog.getAllRawQuotaModels();
  }

  getModelDiscoveryCapabilities(model: string, physicalTarget = false): ModelDiscoveryCapabilities {
    const profile = resolveModelVariant({ model, physicalTarget });
    const requestedModel = profile?.model ?? model.toLowerCase();
    const facts = [...this.options.getTokenCache().values()].flatMap<ModelDiscoveryCapabilities>(
      (token) => {
        const available = this.filterRequestableModels(
          this.getAvailableModelsFromToken(token),
          token.account_id,
        );
        if (available.size === 0) {
          return this.getAvailableModelsFromToken(token).size === 0 ? [{}] : [];
        }
        const physical = this.resolveAvailableModel(
          token,
          requestedModel,
          available,
          undefined,
          physicalTarget || profile !== null,
        );
        if (!physical) {
          return [];
        }
        const evidence = this.getPositiveModelEvidenceFromToken(token).find(
          (entry) => entry.modelId === physical,
        );
        return [
          {
            supports_images: evidence?.details?.modalities?.supportsImages,
            supports_thinking: evidence?.details?.supportsThinking,
            max_output_tokens: evidence?.details?.maxOutputTokens,
          },
        ];
      },
    );
    const supportsImages = consistentCapability(facts.map((fact) => fact.supports_images));
    const supportsThinking = consistentCapability(facts.map((fact) => fact.supports_thinking));
    const maxOutputTokens = consistentCapability(facts.map((fact) => fact.max_output_tokens));
    return {
      ...(supportsImages !== undefined ? { supports_images: supportsImages } : {}),
      ...(supportsThinking !== undefined ? { supports_thinking: supportsThinking } : {}),
      ...(maxOutputTokens !== undefined ? { max_output_tokens: maxOutputTokens } : {}),
    };
  }

  getAvailableModelsFromToken(token: AccountLeaseTokenData): Set<string> {
    return this.catalog.getAvailableModelsFromToken(token);
  }

  getPositiveModelEvidenceFromToken(token: AccountLeaseTokenData): AccountModelEvidence[] {
    return this.catalog.getPositiveModelEvidenceFromToken(token);
  }

  buildDynamicModelCandidates(modelName: string, physicalTarget = false): string[] | null {
    const normalizedModel = normalizeModelId(modelName)?.toLowerCase();
    if (!normalizedModel) {
      return null;
    }

    if (GEMINI_PRO_FAMILY.has(normalizedModel)) {
      return [
        normalizedModel,
        ...GEMINI_PRO_FALLBACKS.filter((candidate) => candidate !== normalizedModel),
      ].filter((candidate) =>
        this.isSafeRegisteredFallback(normalizedModel, candidate, physicalTarget),
      );
    }

    if (GEMINI_PRO_IMAGE_FAMILY.has(normalizedModel)) {
      return [
        normalizedModel,
        ...[...GEMINI_PRO_IMAGE_FAMILY].filter((candidate) => candidate !== normalizedModel),
      ];
    }

    if (GEMINI_FLASH_IMAGE_FAMILY.has(normalizedModel)) {
      return [
        normalizedModel,
        ...[...GEMINI_FLASH_IMAGE_FAMILY].filter((candidate) => candidate !== normalizedModel),
      ];
    }

    if (GEMINI_4_ARGON_FAMILY.has(normalizedModel)) {
      return [
        normalizedModel,
        ...[...GEMINI_4_ARGON_FAMILY].filter((candidate) => candidate !== normalizedModel),
      ].filter((candidate) =>
        this.isSafeRegisteredFallback(normalizedModel, candidate, physicalTarget),
      );
    }

    return null;
  }

  resolveDynamicModelForAccount(
    accountId: string,
    mappedModel: string,
    effort?: string,
    physicalTarget = false,
  ): string {
    const tokenData = this.options.getTokenCache().get(accountId);

    if (!tokenData) {
      return mappedModel;
    }

    const availableModels = this.filterRequestableModels(
      this.getAvailableModelsFromToken(tokenData),
      tokenData.account_id,
    );
    if (availableModels.size === 0) {
      return mappedModel;
    }

    const normalizedMappedModel = normalizeModelId(mappedModel)?.toLowerCase() ?? mappedModel;
    if (
      effort !== undefined &&
      isBareModelFamilyAvailable(normalizedMappedModel, availableModels)
    ) {
      assertSupportedBareModelEffort(effort);
    }
    const resolvedModel = this.resolveAvailableModel(
      tokenData,
      normalizedMappedModel,
      availableModels,
      effort,
      physicalTarget,
    );
    if (!resolvedModel) {
      return mappedModel;
    }
    if (resolvedModel !== normalizedMappedModel) {
      this.options.logger.log(
        `[Dynamic-Model-Rewrite] account=${accountId} ${mappedModel} -> ${resolvedModel}`,
      );
    }
    return resolvedModel;
  }

  getModelAvailabilityForAccount(
    accountId: string,
    mappedModel: string,
    effort?: string,
    physicalTarget = false,
  ): AccountModelAvailability {
    if (isRetiredModel(mappedModel)) {
      return 'unavailable';
    }
    const tokenData = this.options.getTokenCache().get(accountId);
    if (!tokenData) {
      return 'unknown';
    }

    const availableModels = this.filterRequestableModels(
      this.getAvailableModelsFromToken(tokenData),
      tokenData.account_id,
    );
    if (availableModels.size === 0) {
      return this.options.isModelBlocked(accountId, mappedModel) ||
        this.getAvailableModelsFromToken(tokenData).size > 0
        ? 'unavailable'
        : 'unknown';
    }

    const normalizedMappedModel = normalizeModelId(mappedModel)?.toLowerCase();
    if (!normalizedMappedModel) {
      return 'unavailable';
    }

    if (
      effort !== undefined &&
      isBareModelFamilyAvailable(normalizedMappedModel, availableModels)
    ) {
      assertSupportedBareModelEffort(effort);
    }

    const resolvedModel = this.resolveAvailableModel(
      tokenData,
      normalizedMappedModel,
      availableModels,
      effort,
      physicalTarget,
    );
    return resolvedModel ? 'available' : 'unavailable';
  }

  getExactModelAvailabilityForAccount(
    accountId: string,
    mappedModel: string,
    effort?: string,
    physicalTarget = false,
  ): AccountModelAvailability {
    if (isRetiredModel(mappedModel)) {
      return 'unavailable';
    }
    const tokenData = this.options.getTokenCache().get(accountId);
    if (!tokenData) {
      return 'unknown';
    }

    const availableModels = this.filterRequestableModels(
      this.getAvailableModelsFromToken(tokenData),
      tokenData.account_id,
    );
    if (availableModels.size === 0) {
      return this.options.isModelBlocked(accountId, mappedModel) ||
        this.getAvailableModelsFromToken(tokenData).size > 0
        ? 'unavailable'
        : 'unknown';
    }

    const normalizedMappedModel = normalizeModelId(mappedModel)?.toLowerCase();
    if (!normalizedMappedModel) {
      return 'unavailable';
    }

    if (
      effort !== undefined &&
      isBareModelFamilyAvailable(normalizedMappedModel, availableModels)
    ) {
      assertSupportedBareModelEffort(effort);
    }

    if (
      availableModels.has(normalizedMappedModel) &&
      this.isSafeRegisteredFallback(normalizedMappedModel, normalizedMappedModel, physicalTarget)
    ) {
      return 'available';
    }
    if (physicalTarget || effort === undefined) {
      return 'unavailable';
    }
    return resolveBareFamilyModel(normalizedMappedModel, effort, availableModels, true)
      ? 'available'
      : 'unavailable';
  }

  resolveBareModelForAccount(accountId: string, modelName: string, effort?: string): string | null {
    const tokenData = this.options.getTokenCache().get(accountId);
    if (!tokenData) {
      return null;
    }

    const availableModels = this.filterRequestableModels(
      this.getAvailableModelsFromToken(tokenData),
      tokenData.account_id,
    );
    if (availableModels.size === 0) {
      return null;
    }
    return resolveBareFamilyModel(modelName, effort, availableModels);
  }

  parseBareModelEffort(effort: string | undefined): TieredModelSuffix | null {
    return parseBareModelEffort(effort);
  }

  /**
   * Drop upstream-rejected ids from a candidate set so no selection path
   * (forwarding rules, display presets, dynamic candidates, tiered family)
   * can land on a model the generation API refuses to serve.
   */
  private filterRequestableModels(models: Set<string>, accountId: string): Set<string> {
    return new Set(
      [...models].filter(
        (model) => !isRetiredModel(model) && !this.options.isModelBlocked(accountId, model),
      ),
    );
  }

  /**
   * Registered recipes define public-to-physical equivalence. Account binding
   * must not use a different profile merely because that profile is available.
   */
  private isSafeRegisteredFallback(
    requestedModel: string,
    physicalModel: string,
    physicalTarget: boolean,
  ): boolean {
    return isModelTierBindingAllowed(requestedModel, physicalModel, physicalTarget);
  }

  private filterSafeRegisteredFallbacks(
    requestedModel: string,
    availableModels: Set<string>,
    physicalTarget: boolean,
  ): Set<string> {
    return new Set(
      [...availableModels].filter((physicalModel) =>
        this.isSafeRegisteredFallback(requestedModel, physicalModel, physicalTarget),
      ),
    );
  }

  private resolveAvailableModel(
    tokenData: AccountLeaseTokenData,
    normalizedMappedModel: string,
    availableModels: Set<string>,
    effort?: string,
    physicalTarget = false,
  ): string | null {
    if (isRetiredModel(normalizedMappedModel)) {
      return null;
    }
    const forwardedModel = this.resolveForwardedModelForAccount(
      tokenData,
      normalizedMappedModel,
      availableModels,
    );
    if (forwardedModel) {
      const requestedVariant = resolveModelVariant({
        model: normalizedMappedModel,
        physicalTarget,
      });
      if (!requestedVariant || rebindModelVariant(requestedVariant, forwardedModel)) {
        return forwardedModel;
      }
    }

    // Provider retirement rules name a replacement explicitly. Ordinary account
    // fallback below must preserve the resolved request's operating profile.
    const safeAvailableModels = this.filterSafeRegisteredFallbacks(
      normalizedMappedModel,
      availableModels,
      physicalTarget,
    );
    if (physicalTarget) {
      return safeAvailableModels.has(normalizedMappedModel)
        ? normalizedMappedModel
        : ([...safeAvailableModels][0] ?? null);
    }
    const displayPresetModel = this.resolveDisplayPresetForAccount(
      tokenData,
      normalizedMappedModel,
      safeAvailableModels,
    );
    if (displayPresetModel) {
      return displayPresetModel;
    }

    const bareFamilyModel = resolveBareFamilyModel(
      normalizedMappedModel,
      effort,
      safeAvailableModels,
      effort !== undefined,
    );
    if (bareFamilyModel) {
      return bareFamilyModel;
    }

    const candidates = this.buildDynamicModelCandidates(normalizedMappedModel);
    for (const candidate of candidates ?? []) {
      if (safeAvailableModels.has(candidate)) {
        return candidate;
      }
    }

    if (safeAvailableModels.has(normalizedMappedModel)) {
      return normalizedMappedModel;
    }

    return null;
  }

  private resolveDisplayPresetForAccount(
    tokenData: AccountLeaseTokenData,
    normalizedMappedModel: string,
    availableModels: Set<string>,
  ): string | null {
    for (const [modelId, modelInfo] of Object.entries(tokenData.quota?.models ?? {})) {
      if (getPublicModelIdForDisplayName(modelInfo.display_name) !== normalizedMappedModel) {
        continue;
      }
      const normalizedModelId = normalizeModelId(modelId)?.toLowerCase();
      if (normalizedModelId && availableModels.has(normalizedModelId)) {
        return normalizedModelId;
      }
    }
    return null;
  }

  private resolveForwardedModelForAccount(
    tokenData: AccountLeaseTokenData,
    normalizedMappedModel: string,
    availableModels: Set<string>,
  ): string | null {
    const forwardedModel = this.findForwardingTarget(
      tokenData.model_forwarding_rules,
      normalizedMappedModel,
    );
    if (!forwardedModel) {
      return null;
    }

    if (availableModels.has(forwardedModel)) {
      return forwardedModel;
    }

    return null;
  }

  private findForwardingTarget(
    forwardingRules: Record<string, string> | undefined,
    normalizedModel: string,
  ): string | null {
    for (const [oldModel, newModel] of Object.entries(forwardingRules ?? {})) {
      const normalizedOld = normalizeModelId(oldModel)?.toLowerCase();
      const normalizedNew = normalizeModelId(newModel)?.toLowerCase();
      if (normalizedOld === normalizedModel && normalizedNew) {
        return normalizedNew;
      }
    }
    return null;
  }

  /**
   * Precedence: provider `ModelDetails` from the quota payload first, then the persisted
   * `model_limits` compatibility data. Static model specs remain the last resort and stay
   * where they were, in `GenerationConstraintsService`.
   *
   * Before this the provider's own `max_output_tokens` was ignored here, so an account whose
   * quota declared a cap fell through to compatibility data that may predate it.
   */
  getModelOutputLimitForAccount(accountId: string, modelName: string): number | undefined {
    return this.catalog.getModelOutputLimitForAccount(accountId, modelName);
  }

  getModelThinkingBudgetForAccount(accountId: string, modelName: string): number | undefined {
    return this.catalog.getModelThinkingBudgetForAccount(accountId, modelName);
  }

  getModelThinkingTransportForAccount(
    accountId: string,
    modelName: string,
  ): ModelThinkingTransport | undefined {
    return this.catalog.getModelThinkingTransportForAccount(accountId, modelName);
  }
}
