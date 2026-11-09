import { describe, expect, it } from 'vitest';
import type { CloudAccountHealth } from '@/modules/cloud-account/types';
import type { TFunction } from 'i18next';
import {
  getCloudAccountBlockedStatusLabel,
  getCloudAccountHealthBlockKind,
} from '@/modules/cloud-account/utils/accountValidationStatus';

const translate = ((key: string) => key) as unknown as TFunction;

describe('getCloudAccountHealthBlockKind', () => {
  it('shows the durable OAuth reauthorization block before temporary validation', () => {
    const health: CloudAccountHealth = {
      oauth: {
        invalid_grant_count: 2,
        reason: 'invalid_grant',
        refresh_blocked: true,
      },
      validation: {
        detected_at_ms: 1,
        next_probe_at_ms: 2,
        reason: 'VALIDATION_REQUIRED',
        status: 'requires_action',
      },
    };

    expect(getCloudAccountHealthBlockKind(health)).toBe('oauth_reauth');
    expect(
      getCloudAccountBlockedStatusLabel(
        {
          health,
          status: 'expired',
          status_reason: 'Repeated OAuth invalid_grant responses require account reauthorization',
        },
        translate,
      ),
    ).toBe('cloud.card.validationOAuthReauthRequired');
  });

  it('keeps validation visible when it is the only health gate', () => {
    const health: CloudAccountHealth = {
      validation: {
        detected_at_ms: 1,
        next_probe_at_ms: 2,
        reason: 'VALIDATION_REQUIRED',
        status: 'requires_action',
      },
    };

    expect(getCloudAccountHealthBlockKind(health)).toBe('validation');
  });

  it('shows service_disabled before other gates when present', () => {
    const health: CloudAccountHealth = {
      oauth: { refresh_blocked: true },
      validation: {
        detected_at_ms: 1,
        next_probe_at_ms: 2,
        reason: 'VALIDATION_REQUIRED',
        status: 'requires_action',
      },
      service_disabled: {
        status: 'disabled',
        reason: 'TOS_VIOLATION',
        detected_at_ms: 1,
        appeal_url: 'https://forms.gle/test',
      },
    };

    expect(getCloudAccountHealthBlockKind(health)).toBe('service_disabled');
    expect(
      getCloudAccountBlockedStatusLabel(
        { health, status: 'expired', status_reason: 'TOS_VIOLATION' },
        translate,
      ),
    ).toBe('cloud.card.accountDisabledToS');
  });

  it('does not report a health gate when no health is stored', () => {
    expect(getCloudAccountHealthBlockKind(undefined)).toBeNull();
  });

  it('does not label a generic forbidden response as a ToS violation', () => {
    expect(
      getCloudAccountBlockedStatusLabel(
        { status: 'expired', status_reason: 'FORBIDDEN' },
        translate,
      ),
    ).not.toBe('cloud.card.accountDisabledToS');
  });
});
