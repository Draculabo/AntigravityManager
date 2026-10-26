import { isEmpty, isNumber, isString } from 'lodash-es';
import type { CloudQuotaData } from '@/modules/cloud-account/types';

import {
  modelQuotaWindows,
  isExhaustedQuotaWindow,
  latestExhaustedWindowReset,
} from '@/modules/cloud-account/utils/quota-windows';

export interface AccountLeaseQuotaSnapshot {
  modelQuotas: Record<string, number>;
  modelLimits: Record<string, number>;
  modelResetTimes: Record<string, string>;
  modelForwardingRules: Record<string, string>;
}

function normalizeModelId(modelId: string | null | undefined): string | undefined {
  if (!isString(modelId)) {
    return undefined;
  }
  const normalized = modelId.replace(/^models\//i, '').trim();
  return normalized !== '' ? normalized : undefined;
}

export function buildAccountLeaseQuotaSnapshot(
  quota: CloudQuotaData | undefined,
): AccountLeaseQuotaSnapshot {
  const modelQuotas: Record<string, number> = {};
  const modelLimits: Record<string, number> = {};
  const modelResetTimes: Record<string, string> = {};
  const modelForwardingRules: Record<string, string> = {};

  for (const [modelName, modelInfo] of Object.entries(quota?.models ?? {})) {
    const normalizedModel = normalizeModelId(modelName);
    if (!normalizedModel) {
      continue;
    }

    if (Number.isFinite(modelInfo.percentage)) {
      modelQuotas[normalizedModel] = modelInfo.percentage;
    }

    const limitCandidate = modelInfo.max_output_tokens ?? modelInfo.max_tokens;
    if (isNumber(limitCandidate) && Number.isFinite(limitCandidate) && limitCandidate > 0) {
      modelLimits[normalizedModel] = Math.floor(limitCandidate);
    }

    if (isString(modelInfo.resetTime) && !isEmpty(modelInfo.resetTime.trim())) {
      modelResetTimes[normalizedModel] = modelInfo.resetTime;
    }
  }

  for (const model of Object.keys(modelQuotas)) {
    for (const window of modelQuotaWindows(quota, model)) {
      const percentage = isExhaustedQuotaWindow(window) ? 0 : window.remaining_fraction * 100;
      if (percentage < modelQuotas[model]) {
        modelQuotas[model] = percentage;
        modelResetTimes[model] = window.reset_time;
      }
    }
    const reset = latestExhaustedWindowReset(quota, model);
    if (reset && modelQuotas[model] === 0) {
      const current = modelResetTimes[model];
      if (
        !current ||
        !Number.isFinite(Date.parse(current)) ||
        Date.parse(reset) > Date.parse(current)
      ) {
        modelResetTimes[model] = reset;
      }
    }
  }

  for (const [oldModel, newModel] of Object.entries(quota?.model_forwarding_rules ?? {})) {
    const normalizedOld = normalizeModelId(oldModel);
    const normalizedNew = normalizeModelId(newModel);
    if (!normalizedOld || !normalizedNew) {
      continue;
    }
    modelForwardingRules[normalizedOld] = normalizedNew;
  }

  return {
    modelQuotas,
    modelLimits,
    modelResetTimes,
    modelForwardingRules,
  };
}

export function findEarliestQuotaResetTime(modelResetTimes: Record<string, string>): string | null {
  const validTimes = Object.values(modelResetTimes).filter((value) =>
    Number.isFinite(Date.parse(value)),
  );
  if (validTimes.length === 0) {
    return null;
  }
  return [...validTimes].sort((a, b) => Date.parse(a) - Date.parse(b))[0];
}
