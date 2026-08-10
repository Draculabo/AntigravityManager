import { isEmpty, isNumber, isString } from 'lodash-es';
import type { CloudQuotaData } from '@/modules/cloud-account/types';

const THIRD_PARTY_QUOTA_GROUP_PATTERN = /claude|gpt|3p/i;

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

function isThirdPartyModel(modelName: string): boolean {
  const normalizedModelName = modelName.toLowerCase();
  return normalizedModelName.includes('claude') || normalizedModelName.includes('gpt');
}

function extractThirdPartyQuotaFloor(
  quota: CloudQuotaData | undefined,
): { percentage: number; resetTime: string } | null {
  let lowest: { percentage: number; resetTime: string } | null = null;

  for (const group of quota?.quota_groups ?? []) {
    const groupText = [group.display_name, group.description].filter(Boolean).join(' ');
    const groupMatches = THIRD_PARTY_QUOTA_GROUP_PATTERN.test(groupText);

    for (const bucket of group.buckets) {
      const bucketText = [bucket.bucket_id, bucket.window, bucket.display_name, bucket.description]
        .filter(Boolean)
        .join(' ');
      if (!groupMatches && !THIRD_PARTY_QUOTA_GROUP_PATTERN.test(bucketText)) {
        continue;
      }

      const percentage = Math.floor(bucket.remaining_fraction * 100);
      if (!Number.isFinite(percentage)) {
        continue;
      }

      if (
        !lowest ||
        percentage < lowest.percentage ||
        (percentage === lowest.percentage && bucket.reset_time < lowest.resetTime)
      ) {
        lowest = {
          percentage,
          resetTime: bucket.reset_time,
        };
      }
    }
  }

  return lowest;
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
      modelQuotas[normalizedModel] = Math.floor(modelInfo.percentage);
    }

    const limitCandidate = modelInfo.max_output_tokens ?? modelInfo.max_tokens;
    if (isNumber(limitCandidate) && Number.isFinite(limitCandidate) && limitCandidate > 0) {
      modelLimits[normalizedModel] = Math.floor(limitCandidate);
    }

    if (isString(modelInfo.resetTime) && !isEmpty(modelInfo.resetTime.trim())) {
      modelResetTimes[normalizedModel] = modelInfo.resetTime;
    }
  }

  const thirdPartyQuotaFloor = extractThirdPartyQuotaFloor(quota);
  if (thirdPartyQuotaFloor) {
    for (const modelName of Object.keys(modelQuotas)) {
      if (!isThirdPartyModel(modelName)) {
        continue;
      }

      if (thirdPartyQuotaFloor.percentage < modelQuotas[modelName]) {
        modelQuotas[modelName] = thirdPartyQuotaFloor.percentage;
        if (!isEmpty(thirdPartyQuotaFloor.resetTime)) {
          modelResetTimes[modelName] = thirdPartyQuotaFloor.resetTime;
        }
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
  const validTimes = Object.values(modelResetTimes).filter((value) => !isEmpty(value.trim()));
  if (validTimes.length === 0) {
    return null;
  }
  return [...validTimes].sort()[0];
}
