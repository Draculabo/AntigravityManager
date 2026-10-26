import type {
  CloudQuotaData,
  CloudSubscriptionObservation,
  CloudSubscriptionState,
} from '../types';

interface TierIdentity {
  id?: string;
  name?: string;
}

interface SubscriptionInput {
  paidTier?: TierIdentity;
  currentTier?: TierIdentity;
  allowedTiers?: TierIdentity[];
}

type SubscriptionTier = CloudSubscriptionObservation['tier'];
type IdentitySource = Exclude<CloudSubscriptionObservation['source'], 'none'>;

function knownTier(value: string, useName: boolean): SubscriptionTier | undefined {
  switch (value.trim().toLowerCase()) {
    case 'free':
    case 'free-tier':
      return 'free';
    case 'pro':
    case 'g1-pro-tier':
      return 'pro';
    case 'ultra':
    case 'g1-ultra-tier':
      return 'ultra';
    case 'google ai free':
      return useName ? 'free' : undefined;
    case 'google ai pro':
      return useName ? 'pro' : undefined;
    case 'google ai ultra':
      return useName ? 'ultra' : undefined;
    default:
      return undefined;
  }
}

function identify(
  identity: TierIdentity | undefined,
  idSource: IdentitySource,
  nameSource: IdentitySource,
  observedAt: number,
): CloudSubscriptionObservation | undefined {
  const useId = Boolean(identity?.id?.trim());
  const raw = useId ? identity?.id : identity?.name;
  if (!raw?.trim()) {
    return undefined;
  }
  const tier = knownTier(raw, !useId);
  return tier
    ? {
        status: 'known',
        tier,
        source: useId ? idSource : nameSource,
        raw_value: raw,
        observed_at: observedAt,
      }
    : {
        status: 'unrecognized',
        tier: 'free',
        source: useId ? idSource : nameSource,
        raw_value: raw,
        observed_at: observedAt,
      };
}

/** Only paid/current identity proves a paid subscription; recommendations never do. */
export function observeSubscription(
  input: SubscriptionInput,
  observedAt: number,
): CloudSubscriptionState & { refresh_status: 'succeeded' } {
  let observation =
    identify(input.paidTier, 'paid-tier-id', 'paid-tier-name', observedAt) ??
    identify(input.currentTier, 'current-tier-id', 'current-tier-name', observedAt);
  if (!observation) {
    const free = input.allowedTiers
      ?.map((tier) => tier.id)
      .find((id) => id?.trim().toLowerCase() === 'free-tier');
    observation = free
      ? {
          status: 'known',
          tier: 'free',
          source: 'allowed-free-tier',
          raw_value: free,
          observed_at: observedAt,
        }
      : { status: 'missing', tier: 'free', source: 'none', observed_at: observedAt };
  }
  return { refresh_status: 'succeeded', checked_at: observedAt, observation };
}

/** Reconcile subscription independently of model windows; missing evidence never restamps history. */
export function mergeSubscriptionState(
  previous: CloudQuotaData | undefined,
  next: CloudQuotaData,
): Pick<CloudQuotaData, 'subscription_tier' | 'subscription'> {
  const prior = previous?.subscription;
  const current = next.subscription;
  if (!current) {
    if (prior) {
      return {
        subscription_tier: previous.subscription_tier,
        subscription: structuredClone(prior),
      };
    }
    return next.subscription_tier === undefined && previous?.subscription_tier !== undefined
      ? { subscription_tier: previous.subscription_tier }
      : {};
  }
  if (prior && current.checked_at < prior.checked_at) {
    return { subscription_tier: previous.subscription_tier, subscription: structuredClone(prior) };
  }
  if (current.refresh_status === 'succeeded') {
    const hadIdentity = prior?.observation
      ? prior.observation.status !== 'missing'
      : previous?.subscription_tier !== undefined;
    if (current.observation.status === 'missing' && hadIdentity) {
      // A successful project response may still omit subscription authority.
      return {
        subscription_tier: previous?.subscription_tier,
        subscription: {
          refresh_status: 'failed',
          checked_at: current.checked_at,
          ...(prior?.observation ? { observation: structuredClone(prior.observation) } : {}),
        },
      };
    }
    return { subscription_tier: current.observation.tier, subscription: structuredClone(current) };
  }
  const observation =
    prior?.observation &&
    (!current.observation || prior.observation.observed_at > current.observation.observed_at)
      ? prior.observation
      : current.observation;
  return {
    subscription_tier: observation?.tier ?? previous?.subscription_tier,
    subscription: {
      ...current,
      ...(observation ? { observation: structuredClone(observation) } : {}),
    },
  };
}
