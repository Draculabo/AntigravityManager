import { AccountModelCatalog, type AccountModelEvidence } from './account-model-catalog';
import { getPublicModelIdForDisplayName } from '../../../../antigravity/ModelMapping';
import {
  rebindModelVariant,
  resolveModelVariant,
} from '../../../../antigravity/model-variant-registry';
import {
  type AccountLeaseTokenData,
  normalizeModelId,
} from '../interfaces/account-lease-token-types';
import {
  assertSupportedBareModelEffort,
  isBareModelFamilyAvailable,
  parseBareModelEffort,
  resolveBareFamilyModel,
  resolveTieredFamilyModel,
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

const GEMINI_PRO_FAMILY = new Set([
  'gemini-pro-agent',
  'gemini-3-pro',
  'gemini-3-pro-preview',
  'gemini-3-pro-high',
  'gemini-3-pro-low',
  'gemini-3.1-pro',
  'gemini-3.1-pro-preview',
  'gemini-3.1-pro-high',
  'gemini-3.1-pro-low',
]);

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

  getAvailableModelsFromToken(token: AccountLeaseTokenData): Set<string> {
    return this.catalog.getAvailableModelsFromToken(token);
  }

  getPositiveModelEvidenceFromToken(token: AccountLeaseTokenData): AccountModelEvidence[] {
    return this.catalog.getPositiveModelEvidenceFromToken(token);
  }

  buildDynamicModelCandidates(modelName: string): string[] | null {
    const normalizedModel = normalizeModelId(modelName)?.toLowerCase();
    if (!normalizedModel) {
      return null;
    }

    if (GEMINI_PRO_FAMILY.has(normalizedModel)) {
      return this.buildGeminiProCandidates(normalizedModel);
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
      ];
    }

    return null;
  }

  private buildGeminiProCandidates(normalizedModel: string): string[] {
    const candidates: string[] = [];
    const seen = new Set<string>();
    const pushCandidate = (candidate: string) => {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        candidates.push(candidate);
      }
    };

    // Antigravity routes the public high-effort preset through its self-routing
    // agent id. Keep that id first when it is advertised by the leased account.
    if (normalizedModel === 'gemini-pro-agent') {
      pushCandidate(normalizedModel);
    } else if (normalizedModel === 'gemini-3.1-pro-high' || normalizedModel === 'gemini-3.1-pro') {
      // Older quota snapshots may not advertise the agent id, so retain the
      // proven preview fallback chain used by those accounts.
      pushCandidate('gemini-3.1-pro-preview');
      pushCandidate('gemini-3.1-pro');
      pushCandidate(normalizedModel);
    } else {
      pushCandidate(normalizedModel);
    }

    pushCandidate('gemini-pro-agent');
    pushCandidate('gemini-3.1-pro-preview');
    pushCandidate('gemini-3-pro-preview');
    pushCandidate('gemini-3.1-pro-high');
    pushCandidate('gemini-3-pro-high');
    pushCandidate('gemini-3.1-pro-low');
    pushCandidate('gemini-3-pro-low');

    return candidates;
  }

  resolveDynamicModelForAccount(accountId: string, mappedModel: string, effort?: string): string {
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
    const safeAvailableModels = this.filterSafeRegisteredFallbacks(
      normalizedMappedModel,
      availableModels,
    );
    if (
      effort !== undefined &&
      isBareModelFamilyAvailable(normalizedMappedModel, availableModels)
    ) {
      assertSupportedBareModelEffort(effort);
    }
    const resolvedModel = this.resolveAvailableModel(
      tokenData,
      normalizedMappedModel,
      safeAvailableModels,
      effort,
    );
    if (!resolvedModel) {
      return mappedModel;
    }
    if (!this.isSafeRegisteredFallback(mappedModel, resolvedModel)) {
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
  ): AccountModelAvailability {
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

    const safeAvailableModels = this.filterSafeRegisteredFallbacks(
      normalizedMappedModel,
      availableModels,
    );
    const resolvedModel = this.resolveAvailableModel(
      tokenData,
      normalizedMappedModel,
      safeAvailableModels,
      effort,
    );
    return resolvedModel && this.isSafeRegisteredFallback(normalizedMappedModel, resolvedModel)
      ? 'available'
      : 'unavailable';
  }

  getExactModelAvailabilityForAccount(
    accountId: string,
    mappedModel: string,
    effort?: string,
  ): AccountModelAvailability {
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

    if (availableModels.has(normalizedMappedModel)) {
      return 'available';
    }
    if (effort === undefined) {
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
    return new Set([...models].filter((model) => !this.options.isModelBlocked(accountId, model)));
  }

  /**
   * Registered variants may fall back only to another physical model with a
   * registered full parameter tuple. Unregistered requests keep the legacy
   * dynamic-family behavior.
   */
  private isSafeRegisteredFallback(requestedModel: string, physicalModel: string): boolean {
    if (requestedModel.trim().toLowerCase() === physicalModel.trim().toLowerCase()) {
      return true;
    }
    const requestedVariant = resolveModelVariant({ model: requestedModel });
    if (!requestedVariant) {
      return true;
    }
    return rebindModelVariant(requestedVariant, physicalModel) !== null;
  }

  private filterSafeRegisteredFallbacks(
    requestedModel: string,
    availableModels: Set<string>,
  ): Set<string> {
    return new Set(
      [...availableModels].filter((physicalModel) =>
        this.isSafeRegisteredFallback(requestedModel, physicalModel),
      ),
    );
  }

  private resolveAvailableModel(
    tokenData: AccountLeaseTokenData,
    normalizedMappedModel: string,
    availableModels: Set<string>,
    effort?: string,
  ): string | null {
    const forwardedModel = this.resolveForwardedModelForAccount(
      tokenData,
      normalizedMappedModel,
      availableModels,
    );
    if (forwardedModel) {
      return forwardedModel;
    }

    const displayPresetModel = this.resolveDisplayPresetForAccount(
      tokenData,
      normalizedMappedModel,
      availableModels,
    );
    if (displayPresetModel) {
      return displayPresetModel;
    }

    const bareFamilyModel = resolveBareFamilyModel(
      normalizedMappedModel,
      effort,
      availableModels,
      effort !== undefined,
    );
    if (bareFamilyModel) {
      return bareFamilyModel;
    }

    const candidates = this.buildDynamicModelCandidates(normalizedMappedModel);
    for (const candidate of candidates ?? []) {
      if (availableModels.has(candidate)) {
        return candidate;
      }
    }

    if (availableModels.has(normalizedMappedModel)) {
      return normalizedMappedModel;
    }

    const tieredFamilyModel = resolveTieredFamilyModel(normalizedMappedModel, availableModels);
    if (tieredFamilyModel) {
      return tieredFamilyModel;
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
}
