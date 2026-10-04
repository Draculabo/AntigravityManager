import { isEqual, pickBy } from 'lodash-es';
import {
  DesktopPreferencesSchema,
  DesktopPreferencesUpdateSchema,
  ServiceRuntimeSchema,
  ServiceConfigUpdateSchema,
  ServiceConfigSnapshotSchema,
  type SettingsConfig,
} from './service-config.schema';
import { DEFAULT_APP_CONFIG } from './types';
import {
  CloudAccountAlertPolicySchema,
  CloudAccountAlertPolicyUpdateSchema,
} from '@/modules/cloud-account/services/cloud-account-alert-policy.schema';

/** Used only for disabled service controls while desktop preferences load independently. */
export function serviceConfigPlaceholder() {
  const { api_key: _key, upstream_proxy, ...proxy } = DEFAULT_APP_CONFIG.proxy;
  return ServiceConfigSnapshotSchema.parse({
    ...ServiceRuntimeSchema.strip().parse(DEFAULT_APP_CONFIG),
    proxy: {
      ...proxy,
      upstream_proxy: { enabled: upstream_proxy.enabled },
      api_key_configured: false,
      upstream_proxy_configured: false,
    },
  });
}

export function splitSettingsChange(previous: SettingsConfig, next: SettingsConfig) {
  const desktop = DesktopPreferencesSchema.strip().parse(next);
  const previousDesktop = DesktopPreferencesSchema.strip().parse(previous);
  const runtime = ServiceRuntimeSchema.strip().parse(next);
  const previousRuntime = ServiceRuntimeSchema.strip().parse(previous);
  const { api_key_configured: _key, upstream_proxy_configured: _proxy, ...proxy } = next.proxy;
  const changedProxy = pickBy(
    proxy,
    (value, key) => !isEqual(value, Reflect.get(previous.proxy, key)),
  );
  const service = ServiceConfigUpdateSchema.parse({
    ...pickBy(runtime, (value, key) => !isEqual(value, Reflect.get(previousRuntime, key))),
    ...(Object.keys(changedProxy).length ? { proxy: changedProxy } : {}),
  });
  const desktopPatch = DesktopPreferencesUpdateSchema.parse(
    pickBy(desktop, (value, key) => !isEqual(value, Reflect.get(previousDesktop, key))),
  );
  const nextAlerts = CloudAccountAlertPolicySchema.strip().parse(next);
  const previousAlerts = CloudAccountAlertPolicySchema.strip().parse(previous);
  const alertPatch = CloudAccountAlertPolicyUpdateSchema.parse(
    pickBy(nextAlerts, (value, key) => !isEqual(value, Reflect.get(previousAlerts, key))),
  );
  return {
    desktop: Object.keys(desktopPatch).length ? desktopPatch : null,
    accountAlertPolicy: Object.keys(alertPatch).length ? alertPatch : null,
    service: Object.keys(service).length ? service : null,
  };
}
