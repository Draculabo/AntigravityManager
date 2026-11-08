import { isEqual, isPlainObject, mergeWith, pickBy } from 'lodash-es';
import {
  DesktopPreferencesSchema,
  DesktopPreferencesUpdateSchema,
  ServiceRuntimeSchema,
  ServiceConfigUpdateSchema,
  ServiceConfigSnapshotSchema,
  type SettingsConfig,
} from './service-config.schema';
import { DEFAULT_APP_CONFIG } from './types';
import { resolveErrorWindowBudget } from '@/modules/error-diagnostics/configuration';
import {
  CloudAccountAlertPolicySchema,
  CloudAccountAlertPolicyUpdateSchema,
} from '@/modules/cloud-account/services/cloud-account-alert-policy.schema';

/** Used only for disabled service controls while desktop preferences load independently. */
export function serviceConfigPlaceholder() {
  const { api_key: _key, upstream_proxy, ...proxy } = DEFAULT_APP_CONFIG.proxy;
  return ServiceConfigSnapshotSchema.parse({
    errorDiagnosticsBudget: resolveErrorWindowBudget(
      DEFAULT_APP_CONFIG.error_diagnostics.max_storage_mib,
    ),
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
  for (const key of [
    'global_system_prompt',
    'upstream_proxy',
    'experimental',
    'traffic_audit',
    'thought_store',
    'image_scheduler',
    'cowork_compaction',
    'thinking_budget',
    'network',
  ] as const) {
    if (Object.hasOwn(changedProxy, key)) {
      Reflect.set(
        changedProxy,
        key,
        pickBy(proxy[key], (value, field) => !isEqual(value, Reflect.get(previous.proxy[key], field))),
      );
    }
  }
  const service = ServiceConfigUpdateSchema.parse({
    ...(Object.hasOwn(changedProxy, 'traffic_audit')
      ? { expectedAuditRevision: previous.auditRevision }
      : {}),
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

export type SettingsChange = ReturnType<typeof splitSettingsChange>;
const WHOLE_SETTINGS_FIELDS = new Set(['custom_mapping', 'anthropic_mapping', 'model_visibility']);

function replaceWholeSettingsField(_old: unknown, value: unknown, key: string): unknown {
  return Array.isArray(value) || WHOLE_SETTINGS_FIELDS.has(key) ? structuredClone(value) : undefined;
}

/** Arrays are complete field values, while object patches retain independent sibling edits. */
export function mergeSettingsChanges(previous: SettingsChange, next: SettingsChange): SettingsChange {
  const result = structuredClone(previous);
  for (const owner of ['service', 'desktop', 'accountAlertPolicy'] as const) {
    if (next[owner]) {
      Reflect.set(result, owner, mergeWith({}, previous[owner], next[owner], replaceWholeSettingsField));
    }
  }
  return result;
}

export function applySettingsChange(config: SettingsConfig, change: SettingsChange): SettingsConfig {
  const result = structuredClone(config);
  const { expectedAuditRevision: _revision, ...service } = change.service ?? {};
  mergeWith(result, service, change.desktop ?? {}, change.accountAlertPolicy ?? {}, replaceWholeSettingsField);
  return result;
}

/** Remove only confirmed field values; edits made while a save was in flight remain pending. */
export function remainingSettingsChanges(all: SettingsChange, saved: SettingsChange): SettingsChange {
  const result = structuredClone(all);
  function removeConfirmed(target: object, confirmed: object): void {
    for (const [key, value] of Object.entries(confirmed)) {
      const current: unknown = Reflect.get(target, key);
      if (!WHOLE_SETTINGS_FIELDS.has(key) && isPlainObject(value) && isPlainObject(current) && typeof current === 'object' && current !== null) {
        removeConfirmed(current, value);
        if (Object.keys(current).length === 0) {
          Reflect.deleteProperty(target, key);
        }
      } else if (isEqual(current, value)) {
        Reflect.deleteProperty(target, key);
      }
    }
  }
  for (const owner of ['service', 'desktop', 'accountAlertPolicy'] as const) {
    const pending = result[owner];
    const confirmed = saved[owner];
    if (pending && confirmed) {
      removeConfirmed(pending, confirmed);
    }
    if (owner === 'service' && result.service && !result.service.proxy?.traffic_audit) {
      delete result.service.expectedAuditRevision;
    }
    if (pending && Object.keys(pending).length === 0) {
      Reflect.set(result, owner, null);
    }
  }
  return result;
}
