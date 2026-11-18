import {
  modelQuotaWindows,
  isExhaustedQuotaWindow,
  isSameQuotaWindow,
} from '@/modules/cloud-account/utils/quota-windows';
import type { CloudAccount, CloudQuotaData } from '@/modules/cloud-account/types';
import { CloudAccountRefreshContextChangedError } from '@/modules/cloud-account/services/cloud-account-refresh-context';
import { getQuotaModelFamilyId } from '@/modules/cloud-account/utils/quota-model-families';

/** Status labels remain diagnostic; health gates and newly observed hard quota are authoritative. */
export function assertStoredLeaseEligibility(
  account: CloudAccount | undefined,
  model?: string,
  observedQuota?: CloudQuotaData,
): void {
  const now = Date.now();
  if (
    !account ||
    account.health?.oauth?.refresh_blocked ||
    (account.health?.validation?.next_probe_at_ms ?? 0) > now
  ) {
    throw new CloudAccountRefreshContextChangedError(account?.id ?? '[missing]');
  }
  if (!model) {
    return;
  }
  const previousWindows = modelQuotaWindows(observedQuota, model);
  if (
    modelQuotaWindows(account.quota, model).some(
      (window) =>
        isExhaustedQuotaWindow(window) &&
        Date.parse(window.reset_time) > now &&
        !previousWindows.some(
          (previous) =>
            isSameQuotaWindow(previous, window) &&
            previous.reset_time === window.reset_time &&
            isExhaustedQuotaWindow(previous),
        ),
    )
  ) {
    throw new CloudAccountRefreshContextChangedError(account.id);
  }
  const family = getQuotaModelFamilyId(model);
  const previous = Object.entries(observedQuota?.models ?? {});
  const hasNewHardQuota = Object.entries(account.quota?.models ?? {}).some(
    ([candidate, quota]) =>
      getQuotaModelFamilyId(candidate) === family &&
      quota.percentage === 0 &&
      Date.parse(quota.resetTime) > now &&
      !previous.some(
        ([oldModel, oldQuota]) =>
          getQuotaModelFamilyId(oldModel) === family &&
          oldQuota.percentage === 0 &&
          oldQuota.resetTime === quota.resetTime,
      ),
  );
  if (hasNewHardQuota) {
    throw new CloudAccountRefreshContextChangedError(account.id);
  }
}
