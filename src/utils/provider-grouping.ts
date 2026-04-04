/**
 * Provider grouping utilities for categorizing AI models by provider
 * and calculating aggregated statistics.
 */

import { flatMap, groupBy, keys, map, min, sortBy, sumBy } from 'lodash-es';
import { roundQuotaPercentage } from '@/utils/quota-display';

export interface ProviderInfo {
  name: string;
  company: string;
  color: string;
}

export const PROVIDER_REGISTRY: Record<string, ProviderInfo> = {
  'claude-': {
    name: 'Claude',
    company: 'Anthropic',
    color: '#D97757',
  },
  'gemini-': {
    name: 'Gemini',
    company: 'Google',
    color: '#4285F4',
  },
  others: {
    name: 'Other',
    company: 'Various',
    color: '#6B7280',
  },
};

export type ProviderKey = keyof typeof PROVIDER_REGISTRY;

const HEALTH_STATUS_THRESHOLDS = {
  critical: 10,
  limited: 25,
  degraded: 50,
} as const;

/**
 * Detect the provider key for a given model name based on prefix matching.
 */
export function detectProvider(modelName: string): ProviderKey {
  const matchedPrefix = keys(PROVIDER_REGISTRY).find(
    (prefix) => prefix !== 'others' && modelName.startsWith(prefix),
  );

  if (!matchedPrefix) {
    return 'others';
  }

  return matchedPrefix as ProviderKey;
}

/**
 * Get the provider display info for a given model name.
 */
export function getProviderInfo(modelName: string): ProviderInfo {
  const key = detectProvider(modelName);
  return PROVIDER_REGISTRY[key];
}

export interface ModelQuota {
  id: string;
  percentage: number;
  resetTime: string;
}

export interface ProviderStats {
  providerKey: ProviderKey;
  providerInfo: ProviderInfo;
  models: ModelQuota[];
  visibleModels: ModelQuota[];
  avgPercentage: number;
  earliestReset: string | null;
}

function toRoundedAverage(models: ModelQuota[]): number {
  if (models.length === 0) {
    return 0;
  }

  const averagePercentage = sumBy(models, (model) => model.percentage) / models.length;

  return roundQuotaPercentage(averagePercentage);
}

function parseResetTimestamp(resetTime: string): number | null {
  if (!resetTime) {
    return null;
  }

  const timestamp = new Date(resetTime).getTime();
  if (Number.isNaN(timestamp)) {
    return null;
  }

  return timestamp;
}

function resolveAccountHealthStatus(overallPercentage: number): AccountStats['healthStatus'] {
  if (overallPercentage < HEALTH_STATUS_THRESHOLDS.critical) {
    return 'critical';
  }
  if (overallPercentage < HEALTH_STATUS_THRESHOLDS.limited) {
    return 'limited';
  }
  if (overallPercentage < HEALTH_STATUS_THRESHOLDS.degraded) {
    return 'degraded';
  }
  return 'healthy';
}

function buildProviderStats(
  providerKey: ProviderKey,
  models: ModelQuota[],
  visibleModels: ModelQuota[],
  earliestReset: string | null,
): ProviderStats {
  return {
    providerKey,
    providerInfo: PROVIDER_REGISTRY[providerKey],
    models,
    visibleModels,
    avgPercentage: toRoundedAverage(visibleModels),
    earliestReset,
  };
}

/**
 * Calculate aggregated stats for a group of models belonging to one provider.
 */
export function calculateProviderStats(
  providerKey: ProviderKey,
  models: ModelQuota[],
  visibilitySettings: Record<string, boolean>,
): ProviderStats {
  const visibleModels = models.filter((m) => visibilitySettings[m.id] !== false);

  if (visibleModels.length === 0) {
    return buildProviderStats(providerKey, models, [], null);
  }

  const resetTimes = map(visibleModels, (model) => parseResetTimestamp(model.resetTime)).filter(
    (timestamp): timestamp is number => timestamp !== null,
  );

  const earliestTimestamp = min(resetTimes);
  const earliestReset =
    earliestTimestamp !== undefined ? new Date(earliestTimestamp).toISOString() : null;

  return buildProviderStats(providerKey, models, visibleModels, earliestReset);
}

export interface AccountStats {
  providers: ProviderStats[];
  totalModels: number;
  visibleModels: number;
  overallPercentage: number;
  healthStatus: 'healthy' | 'degraded' | 'limited' | 'critical';
}

/**
 * Group models by provider and calculate per-provider and overall account stats.
 */
export function groupModelsByProvider(
  models: Record<string, { percentage: number; resetTime: string }>,
  visibilitySettings: Record<string, boolean>,
): AccountStats {
  const modelQuotas = map(models, (info, modelName) => ({
    providerKey: detectProvider(modelName),
    quota: {
      id: modelName,
      percentage: info.percentage,
      resetTime: info.resetTime,
    },
  }));

  const providerModelGroups = groupBy(modelQuotas, (modelQuota) => modelQuota.providerKey);
  const providerStatsList = map(providerModelGroups, (groupedQuotas, key) => {
    const providerKey = key as ProviderKey;
    const providerModels = map(groupedQuotas, (groupedQuota) => groupedQuota.quota);

    return calculateProviderStats(providerKey, providerModels, visibilitySettings);
  });

  // Sort: known providers first (claude-, gemini-), then others
  const providerDisplayOrder = keys(PROVIDER_REGISTRY);
  const sortedProviders = sortBy(providerStatsList, (providerStats) =>
    providerDisplayOrder.indexOf(providerStats.providerKey),
  );

  const allVisibleModels = flatMap(sortedProviders, (providerStats) => providerStats.visibleModels);
  const totalModels = sumBy(sortedProviders, (providerStats) => providerStats.models.length);
  const overallPercentage = toRoundedAverage(allVisibleModels);
  const healthStatus = resolveAccountHealthStatus(overallPercentage);

  return {
    providers: sortedProviders,
    totalModels,
    visibleModels: allVisibleModels.length,
    overallPercentage,
    healthStatus,
  };
}
