import { useEffect, useMemo } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { CloudAccountView } from '../services/cloud-account-view';
import { getCloudAccountHealthBlockKind } from '../utils/accountValidationStatus';
import { isWeeklyWindow } from '../utils/quota-windows';
import { useQuotaResetClock } from './use-quota-reset-clock';

const attemptedResets = new WeakMap<QueryClient, Map<string, number>>();

export function useWeeklyResetQuotaRefresh(
  accounts: readonly CloudAccountView[] | undefined,
  queryClient: QueryClient,
  refresh: (input: { accountId: string }) => void,
  isRefreshing: boolean,
): void {
  const resets = useMemo(
    () =>
      (accounts ?? []).flatMap((account) => {
        if (
          getCloudAccountHealthBlockKind(account.health) ||
          account.status === 'expired' ||
          account.status_reason === 'service_disabled' ||
          account.status_reason === 'oauth_reauth' ||
          account.status_reason === 'validation_required'
        ) {
          return [];
        }

        return (account.quota?.quota_groups ?? []).flatMap((group) =>
          group.buckets.flatMap((bucket) => {
            const reset = Date.parse(bucket.reset_time);
            if (
              !isWeeklyWindow(bucket) ||
              !Number.isFinite(reset) ||
              (bucket.observed_at !== undefined && bucket.observed_at >= reset)
            ) {
              return [];
            }
            return [{ accountId: account.id, resetTime: bucket.reset_time, reset }];
          }),
        );
      }),
    [accounts],
  );
  const now = useQuotaResetClock(resets.map(({ resetTime }) => resetTime));

  useEffect(() => {
    if (!accounts || isRefreshing || resets.length === 0) {
      return;
    }

    // Keep attempts across Accounts page remounts within the same renderer session.
    const attempted = attemptedResets.get(queryClient) ?? new Map<string, number>();
    attemptedResets.set(queryClient, attempted);
    const due = new Map<string, number>();
    const currentTime = Math.min(now, Date.now());
    for (const { accountId, reset } of resets) {
      if (reset <= currentTime && reset > (attempted.get(accountId) ?? -Infinity)) {
        due.set(accountId, Math.max(due.get(accountId) ?? -Infinity, reset));
      }
    }
    for (const [accountId, reset] of due) {
      attempted.set(accountId, reset);
      refresh({ accountId });
    }
  }, [accounts, isRefreshing, now, queryClient, refresh, resets]);
}
