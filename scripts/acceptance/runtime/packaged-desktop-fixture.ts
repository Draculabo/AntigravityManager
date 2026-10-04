import { DEFAULT_APP_CONFIG } from '../../../src/modules/config/types';
import { DesktopPreferencesSchema } from '../../../src/modules/config/service-config.schema';
import { getLocalEndpoint } from '../../../src/core/local-endpoint';
import { probeProfileOwner } from '../../../src/core/ownership/profile-lease';
import { ManagementClient } from '../../../src/core/management/client';
import { getManagementEndpoint } from '../../../src/core/management/endpoint';

export const config = {
  ...DEFAULT_APP_CONFIG,
  language: 'en',
  auto_startup: false,
  error_reporting_enabled: false,
  telemetry_enabled: false,
  clarity_enabled: false,
  privacy_consent_asked: true,
  proxy: { ...DEFAULT_APP_CONFIG.proxy, auto_start: false },
};
export const preferences = DesktopPreferencesSchema.strip().parse(config);

export function connection(home: string) {
  return {
    management: new ManagementClient(getManagementEndpoint(process.platform, home)),
    probe: () => probeProfileOwner(getLocalEndpoint('profile-owner-v1', process.platform, home)),
  };
}
