import type { TFunction } from 'i18next';
import {
  isOAuthReauthReason,
  isRateLimitReason,
} from '@/modules/cloud-account/utils/account-status';

export type CloudAccountHealthBlockKind = 'oauth_reauth' | 'validation' | null;

interface AccountHealthForDisplay {
  validation?: object;
  oauth?: { refresh_blocked: boolean };
}

/**
 * A durable OAuth refresh block prevents automatic account use, whereas validation is a
 * temporary probe gate. Show the durable recovery requirement first when both are present.
 */
export function getCloudAccountHealthBlockKind(
  health?: AccountHealthForDisplay,
): CloudAccountHealthBlockKind {
  if (health?.oauth?.refresh_blocked) {
    return 'oauth_reauth';
  }
  if (health?.validation) {
    return 'validation';
  }
  return null;
}

export function getValidationBlockedStatusLabel(
  status: 'active' | 'rate_limited' | 'expired' | undefined,
  reason: string | undefined,
  t: TFunction,
): string | null {
  const normalizedReason = (reason || '').toLowerCase();
  const hasReason = normalizedReason !== '';
  const isBlockedByStatus = status === 'rate_limited' || status === 'expired';

  if (!isBlockedByStatus && !hasReason) {
    return null;
  }

  if (status === 'rate_limited' || isRateLimitReason(normalizedReason)) {
    return t('cloud.card.validationRiskControlled');
  }

  if (status === 'expired' || isOAuthReauthReason(normalizedReason)) {
    return t('cloud.card.validationOAuthReauthRequired');
  }

  return t('cloud.card.validationRequired');
}

export function getCloudAccountBlockedStatusLabel(
  account: {
    health?: AccountHealthForDisplay;
    status?: 'active' | 'rate_limited' | 'expired';
    status_reason?: string;
  },
  t: TFunction,
): string | null {
  const healthBlockKind = getCloudAccountHealthBlockKind(account.health);
  if (healthBlockKind === 'oauth_reauth') {
    return t('cloud.card.validationOAuthReauthRequired');
  }
  if (healthBlockKind === 'validation') {
    return t('cloud.card.validationRequired');
  }
  return getValidationBlockedStatusLabel(account.status, account.status_reason, t);
}
