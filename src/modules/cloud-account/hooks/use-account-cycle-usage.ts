import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ipc } from '@/ipc/manager';
import type { CloudQuotaGroup } from '@/modules/cloud-account/types';
import {
  buildCurrentCycleUsageRequests,
  type CurrentCycleUsageRequest,
} from '@/modules/cloud-account/utils/current-cycle-usage';
import { useQuotaResetClock } from './use-quota-reset-clock';

type CurrentCycleUsageResult = Awaited<ReturnType<typeof ipc.client.gateway.auditUsageRange>>;

export interface CurrentCycleUsageEntry {
  request: CurrentCycleUsageRequest;
  result?: CurrentCycleUsageResult;
  failed: boolean;
}

export function useAccountCycleUsage(accountId: string, groups: CloudQuotaGroup[] | undefined) {
  const now = useQuotaResetClock(
    (groups ?? []).flatMap((group) => group.buckets.map((bucket) => bucket.reset_time)),
  );
  const requests = useMemo(() => buildCurrentCycleUsageRequests(groups, now), [groups, now]);
  const query = useQuery<CurrentCycleUsageEntry[]>({
    queryKey: ['cloud-account-cycle-usage', accountId, requests],
    enabled: requests.length > 0,
    staleTime: 30_000,
    retry: false,
    queryFn: async () =>
      Promise.all(
        requests.map(async (request): Promise<CurrentCycleUsageEntry> => {
          try {
            const result = await ipc.client.gateway.auditUsageRange({
              accountId,
              modelIds: request.modelIds,
              from: request.from,
              to: request.to,
            });
            return { request, result, failed: false };
          } catch {
            return { request, failed: true };
          }
        }),
      ),
  });

  return {
    requests,
    entries: query.data ?? [],
    isLoading: requests.length > 0 && query.isPending,
    refetch: query.refetch,
  };
}
