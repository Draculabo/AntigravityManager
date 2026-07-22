import { isNumber } from 'lodash-es';
import { getPublicModelIdForDisplayName } from '../antigravity/ModelMapping';
import { type AccountLeaseTokenData, normalizeModelId } from './account-lease-token-types';

interface AccountLeaseModelLogger {
  log(message: string): void;
}

interface AccountLeaseModelPolicyOptions {
  getTokenCache: () => Map<string, AccountLeaseTokenData>;
  logger: AccountLeaseModelLogger;
}

/**
 * Upstream quota metadata advertises preset ids (e.g. gemini-3.6-flash-low)
 * before the generation API accepts them, so a listed model can still fail
 * with NOT_FOUND. Variant families share a base id and differ only in the
 * trailing effort suffix; when one variant is rejected we reroute to a
 * sibling variant that is still advertised, preferring the self-routing
 * "tiered" preset over explicit effort levels.
 */
const MODEL_VARIANT_SUFFIX_PATTERN = /^(?<base>.+)-(?<variant>tiered|extra-low|low|medium|high)$/;

const MODEL_VARIANT_PRIORITY: Record<string, number> = {
  tiered: 5,
  high: 4,
  medium: 3,
  low: 2,
  'extra-low': 1,
};

const GEMINI_PRO_FAMILY = new Set([
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

const TIERED_MODEL_SUFFIXES = ['extra-low', 'high', 'medium', 'low'] as const;
const TIER_PREFERENCE = ['high', 'medium', 'low', 'extra-low'] as const;
type TieredModelSuffix = (typeof TIER_PREFERENCE)[number];
export type AccountModelAvailability = 'unknown' | 'available' | 'unavailable';

export class AccountLeaseModelPolicy {
  private readonly unrequestableModels = new Set<string>();

  constructor(private readonly options: AccountLeaseModelPolicyOptions) {}

  markModelUnrequestable(modelId: string): void {
    const normalized = normalizeModelId(modelId)?.toLowerCase();
    if (!normalized || this.unrequestableModels.has(normalized)) {
      return;
    }
    this.unrequestableModels.add(normalized);
    this.options.logger.log(
      `[Unrequestable-Model] upstream rejected ${normalized}; future requests will use a family sibling when available`,
    );
  }

  isModelUnrequestable(modelId: string): boolean {
    const normalized = normalizeModelId(modelId)?.toLowerCase();
    return normalized ? this.unrequestableModels.has(normalized) : false;
  }

  resolveUnrequestableSibling(
    modelId: string,
    tokenData?: AccountLeaseTokenData,
  ): string | undefined {
    const normalized = normalizeModelId(modelId)?.toLowerCase();
    if (!normalized || !this.unrequestableModels.has(normalized)) {
      return undefined;
    }

    const match = MODEL_VARIANT_SUFFIX_PATTERN.exec(normalized);
    const base = match?.groups?.base;
    if (!base) {
      return undefined;
    }

    // Restrict sibling candidates to the leased account's own models when
    // token data is available, so one account is never rewritten to a variant
    // that only a different account advertises.
    const candidateModels = tokenData
      ? this.getAvailableModelsFromToken(tokenData)
      : this.getAllCollectedModels();

    const siblings: Array<{ priority: number; modelId: string }> = [];
    for (const collectedModel of candidateModels) {
      const collectedNormalized = normalizeModelId(collectedModel)?.toLowerCase();
      if (!collectedNormalized || this.unrequestableModels.has(collectedNormalized)) {
        continue;
      }
      const collectedMatch = MODEL_VARIANT_SUFFIX_PATTERN.exec(collectedNormalized);
      if (collectedMatch?.groups?.base !== base) {
        continue;
      }
      siblings.push({
        priority: MODEL_VARIANT_PRIORITY[collectedMatch.groups.variant] ?? 0,
        modelId: collectedNormalized,
      });
    }

    siblings.sort((a, b) => b.priority - a.priority);
    return siblings[0]?.modelId;
  }

  getAllCollectedModels(): Set<string> {
    const allModels = new Set<string>();
    for (const tokenData of this.options.getTokenCache().values()) {
      const describedModels = new Set<string>();
      for (const [modelId, modelInfo] of Object.entries(tokenData.quota?.models ?? {})) {
        const normalizedModelId = normalizeModelId(modelId)?.toLowerCase();
        if (!normalizedModelId) {
          continue;
        }
        describedModels.add(normalizedModelId);
        allModels.add(getPublicModelIdForDisplayName(modelInfo.display_name) ?? normalizedModelId);
      }

      for (const modelId of Object.keys(tokenData.model_quotas)) {
        const normalizedModelId = normalizeModelId(modelId)?.toLowerCase();
        if (normalizedModelId && !describedModels.has(normalizedModelId)) {
          allModels.add(normalizedModelId);
        }
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

    // Upstream rejects the '-high' suffix for gemini-3.1-pro requests, so
    // prefer the preview model before falling back to the requested variant.
    if (normalizedModel === 'gemini-3.1-pro-high' || normalizedModel === 'gemini-3.1-pro') {
      pushCandidate('gemini-3.1-pro-preview');
      pushCandidate('gemini-3.1-pro');
      pushCandidate(normalizedModel);
    } else {
      pushCandidate(normalizedModel);
    }

    pushCandidate('gemini-3.1-pro-preview');
    pushCandidate('gemini-3-pro-preview');
    pushCandidate('gemini-3.1-pro-high');
    pushCandidate('gemini-3-pro-high');
    pushCandidate('gemini-3.1-pro-low');
    pushCandidate('gemini-3-pro-low');

    return candidates;
  }

  resolveDynamicModelForAccount(accountId: string, mappedModel: string): string {
    const tokenData = this.options.getTokenCache().get(accountId);
    const unrequestableSibling = this.resolveUnrequestableSibling(mappedModel, tokenData);
    if (unrequestableSibling) {
      this.options.logger.log(
        `[Unrequestable-Model-Rewrite] account=${accountId} ${mappedModel} -> ${unrequestableSibling}`,
      );
      return unrequestableSibling;
    }

    if (!tokenData) {
      return mappedModel;
    }

    const availableModels = this.filterRequestableModels(
      this.getAvailableModelsFromToken(tokenData),
    );
    if (availableModels.size === 0) {
      return mappedModel;
    }

    const normalizedMappedModel = normalizeModelId(mappedModel)?.toLowerCase() ?? mappedModel;
    const resolvedModel = this.resolveAvailableModel(
      tokenData,
      normalizedMappedModel,
      availableModels,
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

  getModelAvailabilityForAccount(accountId: string, mappedModel: string): AccountModelAvailability {
    const tokenData = this.options.getTokenCache().get(accountId);
    if (!tokenData) {
      return 'unknown';
    }

    const availableModels = this.filterRequestableModels(
      this.getAvailableModelsFromToken(tokenData),
    );
    if (availableModels.size === 0) {
      return 'unknown';
    }

    const normalizedMappedModel = normalizeModelId(mappedModel)?.toLowerCase();
    if (!normalizedMappedModel) {
      return 'unavailable';
    }

    return this.resolveAvailableModel(tokenData, normalizedMappedModel, availableModels)
      ? 'available'
      : 'unavailable';
  }

  /**
   * Drop upstream-rejected ids from a candidate set so no selection path
   * (forwarding rules, display presets, dynamic candidates, tiered family)
   * can land on a model the generation API refuses to serve.
   */
  private filterRequestableModels(models: Set<string>): Set<string> {
    if (this.unrequestableModels.size === 0) {
      return models;
    }
    const filtered = new Set<string>();
    for (const modelId of models) {
      if (!this.unrequestableModels.has(modelId)) {
        filtered.add(modelId);
      }
    }
    return filtered;
  }

  private resolveAvailableModel(
    tokenData: AccountLeaseTokenData,
    normalizedMappedModel: string,
    availableModels: Set<string>,
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

    const candidates = this.buildDynamicModelCandidates(normalizedMappedModel);
    for (const candidate of candidates ?? []) {
      if (availableModels.has(candidate)) {
        return candidate;
      }
    }

    if (availableModels.has(normalizedMappedModel)) {
      return normalizedMappedModel;
    }

    const tieredFamilyModel = this.resolveTieredFamilyModel(normalizedMappedModel, availableModels);
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

  private resolveTieredFamilyModel(
    normalizedMappedModel: string,
    availableModels: Set<string>,
  ): string | null {
    const requested = this.parseTieredModel(normalizedMappedModel);
    if (!requested) {
      return null;
    }

    const familyCandidates = [...availableModels]
      .map((model) => ({ model, parsed: this.parseTieredModel(model) }))
      .filter(
        (
          item,
        ): item is {
          model: string;
          parsed: { base: string; tier: TieredModelSuffix };
        } => item.parsed?.base === requested.base,
      );
    if (familyCandidates.length === 0) {
      return null;
    }

    familyCandidates.sort(
      (a, b) =>
        this.getTierDistance(requested.tier, a.parsed.tier) -
        this.getTierDistance(requested.tier, b.parsed.tier),
    );

    return familyCandidates[0]?.model ?? null;
  }

  private parseTieredModel(
    normalizedModel: string,
  ): { base: string; tier: TieredModelSuffix } | null {
    for (const suffix of TIERED_MODEL_SUFFIXES) {
      const marker = `-${suffix}`;
      if (!normalizedModel.endsWith(marker)) {
        continue;
      }
      return {
        base: normalizedModel.slice(0, -marker.length),
        tier: suffix as TieredModelSuffix,
      };
    }
    return null;
  }

  private getTierDistance(
    requestedTier: TieredModelSuffix,
    candidateTier: TieredModelSuffix,
  ): number {
    const requestedIndex = TIER_PREFERENCE.indexOf(requestedTier);
    const candidateIndex = TIER_PREFERENCE.indexOf(candidateTier);
    if (candidateIndex >= requestedIndex) {
      return candidateIndex - requestedIndex;
    }
    return TIER_PREFERENCE.length + requestedIndex - candidateIndex;
  }

  getModelOutputLimitForAccount(accountId: string, modelName: string): number | undefined {
    const tokenData = this.options.getTokenCache().get(accountId);
    const normalizedModel = normalizeModelId(modelName);
    if (!tokenData || !normalizedModel) {
      return undefined;
    }
    return tokenData.model_limits[normalizedModel];
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
