import type { CloudQuotaBucket, CloudQuotaData, CloudQuotaGroup } from '../types';
import { mergeSubscriptionState } from './subscription-tier';
import {
  getQuotaGroupModelMembership,
  normalizeQuotaModelId,
} from './quota-group-model-membership';

export function isWeeklyWindow(bucket: CloudQuotaBucket): boolean {
  return /week|(?:^|\W)7d(?:$|\W)/i.test(`${bucket.window} ${bucket.bucket_id}`);
}

function validFraction(bucket: CloudQuotaBucket): boolean {
  return (
    Number.isFinite(bucket.remaining_fraction) &&
    bucket.remaining_fraction >= 0 &&
    bucket.remaining_fraction <= 1
  );
}

export function isExhaustedQuotaWindow(bucket: CloudQuotaBucket): boolean {
  return validFraction(bucket) && bucket.remaining_fraction <= (isWeeklyWindow(bucket) ? 0.001 : 0);
}

function matchesGroup(group: CloudQuotaGroup, model: string): boolean {
  const target = normalizeQuotaModelId(model);
  const membership = getQuotaGroupModelMembership(group, target);
  if (membership === 'authoritative') {
    return true;
  }
  if (membership === 'unknown') {
    return false;
  }
  const label = `${group.display_name} ${group.description ?? ''}`.toLowerCase();
  // The existing summary has no model membership IDs. Keep this explicit legacy
  // matcher separate from D08's future authoritative group/model identity mapping.
  if (label.includes(target)) {
    return true;
  }
  if (label.includes('claude')) {
    if (label.includes('gpt')) {
      return target.startsWith('claude-') || target.startsWith('gpt-');
    }
    const family = ['sonnet', 'opus', 'haiku'].find((name) => label.includes(name));
    return target.startsWith(family ? `claude-${family}` : 'claude-');
  }
  if (label.includes('gpt')) {
    return target.startsWith('gpt-');
  }
  if (label.includes('gemini')) {
    const family = ['flash', 'pro'].find((name) => label.includes(name));
    return target.startsWith('gemini-') && (!family || target.includes(family));
  }
  return (
    /3p/i.test(`${label} ${group.buckets.map((bucket) => bucket.bucket_id).join(' ')}`) &&
    (target.startsWith('claude-') || target.startsWith('gpt-'))
  );
}

export function modelQuotaWindows(
  quota: CloudQuotaData | undefined,
  model: string,
  _effort?: string,
): CloudQuotaBucket[] {
  return (quota?.quota_groups ?? [])
    .filter((group) => matchesGroup(group, model))
    .flatMap((group) => group.buckets.filter(validFraction));
}

export function latestExhaustedWindowReset(
  quota: CloudQuotaData | undefined,
  model: string,
): string | undefined {
  return modelQuotaWindows(quota, model)
    .filter(isExhaustedQuotaWindow)
    .filter((bucket) => Number.isFinite(Date.parse(bucket.reset_time)))
    .sort((a, b) => Date.parse(b.reset_time) - Date.parse(a.reset_time))[0]?.reset_time;
}

export function quotaWindowWaitSeconds(
  quota: CloudQuotaData | undefined,
  model: string,
  now = Date.now(),
): number {
  const reset = latestExhaustedWindowReset(quota, model);
  return reset ? Math.max(0, Math.ceil((Date.parse(reset) - now) / 1000)) : 0;
}

function bucketKey(bucket: CloudQuotaBucket): string {
  const window = bucket.window.trim().toLowerCase();
  const canonical = ['week', 'weekly', '7d'].includes(window) ? 'weekly' : window;
  return JSON.stringify([bucket.bucket_id, canonical]);
}

export function isSameQuotaWindow(left: CloudQuotaBucket, right: CloudQuotaBucket): boolean {
  return bucketKey(left) === bucketKey(right);
}

function isCurrentWindowObservation(
  previous: CloudQuotaBucket,
  candidate: CloudQuotaBucket,
  now = Date.now(),
): boolean {
  return (
    validFraction(candidate) &&
    Date.parse(candidate.reset_time) > now &&
    (previous.observed_at === undefined ||
      (candidate.observed_at !== undefined && candidate.observed_at >= previous.observed_at))
  );
}

/** Missing summary fields are not observations of recovery. Existing payload shape is retained. */
export function mergeQuotaWindows(
  previous: CloudQuotaData | undefined,
  next: CloudQuotaData,
  now = Date.now(),
): CloudQuotaData {
  const reconciled = { ...next, ...mergeSubscriptionState(previous, next) };
  if (!previous?.quota_groups?.length) {
    return reconciled;
  }
  const groups = structuredClone(next.quota_groups ?? []);
  for (const oldGroup of previous.quota_groups) {
    const retained = oldGroup.buckets.filter((bucket) => {
      const reset = Date.parse(bucket.reset_time);
      // Keep expired depletion as a probe requirement, without inventing its next cycle.
      return !Number.isFinite(reset) || reset > now || isExhaustedQuotaWindow(bucket);
    });
    const matching = groups.find((group) => group.display_name === oldGroup.display_name);
    if (!matching) {
      if (retained.length) {
        groups.push({ ...oldGroup, buckets: structuredClone(retained) });
      }
      continue;
    }
    for (const bucket of retained) {
      if (
        !matching.buckets.some(
          (candidate) =>
            isSameQuotaWindow(candidate, bucket) &&
            (isCurrentWindowObservation(bucket, candidate, now) ||
              // A local clock rollback must not hide a newly reported hard restriction.
              (isExhaustedQuotaWindow(candidate) && !isExhaustedQuotaWindow(bucket))),
        )
      ) {
        matching.buckets = matching.buckets.filter(
          (candidate) => bucketKey(candidate) !== bucketKey(bucket),
        );
        matching.buckets.push(structuredClone(bucket));
      }
    }
  }
  return { ...reconciled, quota_groups: groups };
}

/** Only explicitly refreshed windows can release protection previously learned from the summary. */
export function hasFreshQuotaWindows(
  previous: CloudQuotaData | undefined,
  next: CloudQuotaData,
  model: string,
  now = Date.now(),
  _effort?: string,
): boolean {
  const oldGroups = (previous?.quota_groups ?? []).filter((group) => matchesGroup(group, model));
  return oldGroups.every((oldGroup) => {
    const fresh = next.quota_groups?.find((group) => group.display_name === oldGroup.display_name);
    return oldGroup.buckets.every(
      (bucket) =>
        Boolean(bucket.bucket_id.trim() && bucket.window.trim()) &&
        fresh?.buckets.some(
          (candidate) =>
            isSameQuotaWindow(candidate, bucket) &&
            isCurrentWindowObservation(bucket, candidate, now),
        ),
    );
  });
}
