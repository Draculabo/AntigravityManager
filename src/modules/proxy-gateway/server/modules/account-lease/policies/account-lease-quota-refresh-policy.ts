import type { AccountLeaseAccountStore, AccountLeaseUpstream } from '../interfaces/account-lease-adapters';
import {
  buildAccountLeaseQuotaSnapshot,
  findEarliestQuotaResetTime,
  type AccountLeaseQuotaSnapshot,
} from './account-lease-quota-policy';
import { type AccountLeaseTokenData, normalizeModelId } from '../interfaces/account-lease-token-types';
import { RateLimitReason } from '../../shared/services/rate-limit-tracker.service';
import { updateDynamicForwardingRules } from '../../../../antigravity/ModelMapping';
import { getQuotaModelFamilyId } from '@/modules/cloud-account/utils/quota-model-families';

interface AccountLeaseQuotaRefreshLogger {
  warn(message: string, error?: unknown): void;
}

interface AccountLeaseQuotaRefreshPolicyOptions {
  accountStore: AccountLeaseAccountStore;
  upstream: AccountLeaseUpstream;
  getTokenCache: () => Map<string, AccountLeaseTokenData>;
  setLockoutUntilIso: (
    accountId: string,
    resetTime: string,
    reason: RateLimitReason,
    model?: string,
  ) => boolean;
  clearRecoveredQuotaLocks: (
    accountId: string,
    recoveredModels: readonly string[],
    isAccountRecovered: boolean,
  ) => void;
  logger: AccountLeaseQuotaRefreshLogger;
}

interface ModelQuotaFamilyState {
  percentage: number;
  resetTimes: string[];
}

export type AccountLeaseQuotaRefreshOutcome = 'locked' | 'recovered' | 'unavailable';

function buildModelQuotaFamilyStates(
  snapshot: AccountLeaseQuotaSnapshot,
): Map<string, ModelQuotaFamilyState> {
  const states = new Map<string, ModelQuotaFamilyState>();

  for (const [model, percentage] of Object.entries(snapshot.modelQuotas)) {
    const family = getQuotaModelFamilyId(model);
    const current = states.get(family);
    states.set(family, {
      percentage: current ? Math.min(current.percentage, percentage) : percentage,
      resetTimes: current?.resetTimes ?? [],
    });
  }

  for (const [model, resetTime] of Object.entries(snapshot.modelResetTimes)) {
    if (resetTime.trim() === '') {
      continue;
    }

    const family = getQuotaModelFamilyId(model);
    const state = states.get(family);
    if (state) {
      state.resetTimes.push(resetTime);
      continue;
    }

    // Older cached snapshots may have reset metadata without percentages.
    // Preserve their fail-closed lock behavior until a complete live snapshot replaces them.
    states.set(family, {
      percentage: 0,
      resetTimes: [resetTime],
    });
  }

  return states;
}

function resolveQuotaFamily(
  model: string,
  snapshot: AccountLeaseQuotaSnapshot,
  familyStates: ReadonlyMap<string, ModelQuotaFamilyState>,
): string {
  let candidate = normalizeModelId(model) ?? model;
  const visited = new Set<string>();

  while (!visited.has(candidate.toLowerCase())) {
    visited.add(candidate.toLowerCase());
    const family = getQuotaModelFamilyId(candidate);
    if (familyStates.has(family)) {
      return family;
    }

    const forwardedEntry = Object.entries(snapshot.modelForwardingRules).find(
      ([oldModel]) => oldModel.toLowerCase() === candidate.toLowerCase(),
    );
    if (!forwardedEntry) {
      return family;
    }
    candidate = forwardedEntry[1];
  }

  return getQuotaModelFamilyId(candidate);
}

function findEarliestFamilyResetTime(state: ModelQuotaFamilyState): string | null {
  if (state.resetTimes.length === 0) {
    return null;
  }
  return [...state.resetTimes].sort()[0];
}

export class AccountLeaseQuotaRefreshPolicy {
  constructor(private readonly options: AccountLeaseQuotaRefreshPolicyOptions) {}

  applyModelForwardingRules(snapshot: AccountLeaseQuotaSnapshot): void {
    for (const [oldModel, newModel] of Object.entries(snapshot.modelForwardingRules)) {
      updateDynamicForwardingRules(oldModel, newModel);
    }
  }

  setPreciseLockoutFromCachedQuota(
    accountId: string,
    reason: RateLimitReason,
    model?: string,
  ): boolean {
    const tokenData = this.options.getTokenCache().get(accountId);
    if (!tokenData) {
      return false;
    }

    let resetTime: string | null;
    if (model) {
      const snapshot: AccountLeaseQuotaSnapshot = {
        modelQuotas: tokenData.model_quotas,
        modelLimits: tokenData.model_limits,
        modelResetTimes: tokenData.model_reset_times,
        modelForwardingRules: tokenData.model_forwarding_rules,
      };
      const familyStates = buildModelQuotaFamilyStates(snapshot);
      const familyState = familyStates.get(resolveQuotaFamily(model, snapshot, familyStates));
      if (!familyState || familyState.percentage > 0) {
        return false;
      }
      resetTime = findEarliestFamilyResetTime(familyState);
    } else {
      resetTime = findEarliestQuotaResetTime(tokenData.model_reset_times);
    }

    if (!resetTime) {
      return false;
    }

    return this.options.setLockoutUntilIso(accountId, resetTime, reason, model);
  }

  async refreshRealtimeQuotaAndReconcileLimit(
    accountId: string,
    reason: RateLimitReason,
    model?: string,
  ): Promise<AccountLeaseQuotaRefreshOutcome> {
    const tokenData = this.options.getTokenCache().get(accountId);
    if (!tokenData) {
      return 'unavailable';
    }

    try {
      const latestQuota = await this.options.upstream.fetchQuota(
        tokenData.access_token,
        tokenData.upstream_proxy_url,
      );
      const extractedState = buildAccountLeaseQuotaSnapshot(latestQuota);

      await this.options.accountStore.updateQuota(accountId, latestQuota);

      const updatedTokenData: AccountLeaseTokenData = {
        ...tokenData,
        quota: latestQuota,
        model_quotas: extractedState.modelQuotas,
        model_limits: extractedState.modelLimits,
        model_reset_times: extractedState.modelResetTimes,
        model_forwarding_rules: extractedState.modelForwardingRules,
      };
      this.options.getTokenCache().set(accountId, updatedTokenData);
      this.applyModelForwardingRules(extractedState);

      const familyStates = buildModelQuotaFamilyStates(extractedState);
      const recoveredFamilies = new Set(
        Array.from(familyStates.entries())
          .filter(([, state]) => state.percentage > 0)
          .map(([family]) => family),
      );
      const recoveredModels = new Set(
        Object.keys(extractedState.modelQuotas).filter((candidate) =>
          recoveredFamilies.has(getQuotaModelFamilyId(candidate)),
        ),
      );
      for (const oldModel of Object.keys(extractedState.modelForwardingRules)) {
        const forwardedFamily = resolveQuotaFamily(oldModel, extractedState, familyStates);
        if (recoveredFamilies.has(forwardedFamily)) {
          recoveredModels.add(oldModel);
        }
      }

      const normalizedModel = normalizeModelId(model);
      const requestedFamily = normalizedModel
        ? resolveQuotaFamily(normalizedModel, extractedState, familyStates)
        : undefined;
      const requestedState = requestedFamily ? familyStates.get(requestedFamily) : undefined;
      if (normalizedModel && requestedState && requestedState.percentage > 0) {
        recoveredModels.add(normalizedModel);
      }

      const isAccountRecovered =
        familyStates.size > 0 &&
        Array.from(familyStates.values()).every((state) => state.percentage > 0);
      if (recoveredModels.size > 0 || isAccountRecovered) {
        this.options.clearRecoveredQuotaLocks(
          accountId,
          Array.from(recoveredModels),
          isAccountRecovered,
        );
      }

      if (requestedState) {
        if (requestedState.percentage > 0) {
          return 'recovered';
        }

        const resetTime = findEarliestFamilyResetTime(requestedState);
        if (!resetTime) {
          return 'unavailable';
        }
        return this.options.setLockoutUntilIso(accountId, resetTime, reason, normalizedModel)
          ? 'locked'
          : 'unavailable';
      }

      if (normalizedModel) {
        return 'unavailable';
      }

      if (isAccountRecovered) {
        return 'recovered';
      }

      const resetTime = findEarliestQuotaResetTime(extractedState.modelResetTimes);
      if (!resetTime) {
        return 'unavailable';
      }
      return this.options.setLockoutUntilIso(accountId, resetTime, reason)
        ? 'locked'
        : 'unavailable';
    } catch (error) {
      this.options.logger.warn(`Failed to refresh realtime quota for account ${accountId}`, error);
      return 'unavailable';
    }
  }
}
