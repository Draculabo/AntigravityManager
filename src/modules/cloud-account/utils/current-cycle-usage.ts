import type { CloudQuotaGroup } from '@/modules/cloud-account/types';
import { normalizeQuotaModelId } from './quota-group-model-membership';
import { weeklyQuotaCycle } from './weekly-quota-cycle';

export interface CurrentCycleUsageRequest {
  id: string;
  groupName: string;
  groupDescription?: string;
  modelIds: string[];
  from: number;
  to: number;
}

/**
 * Build only provider-group requests with explicit physical model membership.
 * Label-only legacy groups are intentionally excluded so the UI cannot
 * present a broad family prefix as an official cycle total.
 */
export function buildCurrentCycleUsageRequests(
  groups: CloudQuotaGroup[] | undefined,
  now: number,
): CurrentCycleUsageRequest[] {
  const requests = new Map<string, CurrentCycleUsageRequest>();

  for (const group of groups ?? []) {
    if (!group.model_ids?.length) {
      continue;
    }

    const modelIds = [
      ...new Set(
        group.model_ids
          .map(normalizeQuotaModelId)
          .filter((modelId): modelId is string => modelId.length > 0),
      ),
    ].sort();
    if (modelIds.length === 0) {
      continue;
    }

    for (const bucket of group.buckets) {
      const cycle = weeklyQuotaCycle(bucket, now);
      if (cycle.state !== 'available') {
        continue;
      }

      const id = [group.display_name, cycle.from, cycle.to, modelIds.join(',')].join(':');
      requests.set(id, {
        id,
        groupName: group.display_name,
        groupDescription: group.description,
        modelIds,
        from: cycle.from,
        to: cycle.to,
      });
    }
  }

  return [...requests.values()].sort((left, right) => left.id.localeCompare(right.id));
}
